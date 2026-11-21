#!/usr/bin/env node
// CLI entry: `npx pulled`. Exit codes: 0 in sync, 1 out of sync, 2 internal error.
import { type StdioOptions, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { format, useColor } from './report';
import { runAll } from './run';
import type { Context, Report } from './types';
import { createContext, execCmd } from './util/context';

const USAGE = `Usage: pulled [options]

Checks whether your local setup is in sync with the code you pulled.

Options:
  --fix          run the fix commands (install, prisma generate, prisma migrate deploy), then check again
  --json         print the report as JSON to stdout
  --cwd <dir>    check the project in <dir> instead of the current directory
  --help         show this help
  --version      show the version

Exit codes: 0 in sync, 1 out of sync, 2 internal error.
`;

async function main(): Promise<number> {
  let values: { fix?: boolean; json?: boolean; cwd?: string; help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        fix: { type: 'boolean' },
        json: { type: 'boolean' },
        cwd: { type: 'string' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    }));
  } catch (err) {
    process.stderr.write(`pulled: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const load = () => createContext({ cwd });
  let ctx = load();
  if (!ctx) {
    process.stderr.write(`pulled: no package.json found in ${cwd} or any parent directory\n`);
    return 2;
  }
  let report = await runAll(ctx);
  if (values.fix && !report.ok) {
    fix(ctx, report, values.json === true);
    ctx = load() ?? ctx;
    report = await runAll(ctx);
  }

  for (const { id, reason } of report.skipped) ctx.debug(`skipped ${id}: ${reason}`);
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const color = useColor(process.stderr, process.env);
    process.stderr.write(format(report.issues, { color, fixHint: !values.fix }));
  }
  return report.ok ? 0 : 1;
}

/**
 * Runs the fix steps in order (install → prisma generate → prisma migrate deploy), streaming their
 * output, and stops at the first failing step. env and node issues are never auto-fixed.
 */
function fix(ctx: Context, report: Report, json: boolean): void {
  const has = (id: string) => report.issues.find((i) => i.id === id && i.fix !== undefined);
  const prisma = execCmd(ctx.pm, 'prisma');
  const steps: [string, string][] = [];
  const deps = has('deps');
  if (deps?.fix) steps.push([deps.fix, ctx.rootDir]);
  if (has('prisma-client')) steps.push([`${prisma} generate`, ctx.pkgDir]);
  if (has('migrations')) steps.push([`${prisma} migrate deploy`, ctx.pkgDir]);

  for (const [command, cwd] of steps) {
    process.stderr.write(`\n→ ${command}\n`);
    const [bin, ...args] = command.split(' ') as [string, ...string[]];
    // With --json, stdout carries only the report, so the commands' output goes to stderr.
    const stdio: StdioOptions = json ? ['inherit', 2, 'inherit'] : 'inherit';
    const result = spawnSync(bin, args, { cwd, stdio });
    if (result.status !== 0) {
      const why = result.error ? result.error.message : `exit code ${result.status}`;
      process.stderr.write(`pulled: \`${command}\` failed (${why})\n`);
      return;
    }
  }
  if (steps.length > 0) process.stderr.write('\n');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`pulled: internal error: ${(err as Error)?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
