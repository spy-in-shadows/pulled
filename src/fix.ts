// `pulled --fix`: runs the fix commands for the fixable issues of a report.
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import type { Context, Report } from './types';
import { execCmd } from './util/context';

/**
 * The fix steps in order (install → prisma generate → prisma migrate deploy) as [command, cwd].
 * env and node issues are never auto-fixed.
 */
export function fixSteps(ctx: Context, report: Report): [string, string][] {
  const has = (id: string) => report.issues.find((i) => i.id === id && i.fix !== undefined);
  const prisma = execCmd(ctx.pm, 'prisma');
  const steps: [string, string][] = [];
  const deps = has('deps');
  if (deps?.fix) steps.push([deps.fix, ctx.rootDir]);
  if (has('prisma-client')) steps.push([`${prisma} generate`, ctx.pkgDir]);
  if (has('migrations')) steps.push([`${prisma} migrate deploy`, ctx.pkgDir]);
  return steps;
}

/**
 * The spawnSync arguments for a fix command. Elsewhere it's spawned directly, never through a shell.
 * On Windows, npm/npx/pnpm/yarn are .cmd shims, which Node can only run through a shell, so there
 * the command goes through cmd.exe as one string. That's safe only because every command is a fixed
 * string pulled builds itself (fixSteps above): no user, file or env input may ever go into them.
 */
export function spawnArgs(
  command: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[], SpawnSyncOptions] {
  if (platform === 'win32') return [command, [], { shell: true }];
  const [bin, ...args] = command.split(' ') as [string, ...string[]];
  return [bin, args, {}];
}

/** Runs the steps, streaming their output, and stops at the first failing step. */
export function runFix(steps: [string, string][], json: boolean): void {
  for (const [command, cwd] of steps) {
    process.stderr.write(`\n→ ${command}\n`);
    const [bin, args, opts] = spawnArgs(command);
    // With --json, stdout carries only the report, so the commands' output goes to stderr.
    const stdio: SpawnSyncOptions['stdio'] = json ? ['inherit', 2, 'inherit'] : 'inherit';
    const result = spawnSync(bin, args, { ...opts, cwd, stdio });
    if (result.status !== 0) {
      const why = result.error ? result.error.message : `exit code ${result.status}`;
      process.stderr.write(`pulled: \`${command}\` failed (${why})\n`);
      return;
    }
  }
  if (steps.length > 0) process.stderr.write('\n');
}
