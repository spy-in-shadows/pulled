#!/usr/bin/env node
// CLI entry: `npx pulled`. Exit codes: 0 in sync, 1 out of sync, 2 internal error.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fixSteps, runFix } from './fix';
import { format, useColor } from './report';
import { runAll } from './run';
import { createContext, pulledOff } from './util/context';

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

  // PULLED=0/false/off turns pulled off everywhere; the CLI still ignores NODE_ENV and CI.
  if (pulledOff(process.env)) return 0;

  const cwd = resolve(values.cwd ?? process.cwd());
  const load = () => createContext({ cwd });
  let ctx = load();
  if (!ctx) {
    process.stderr.write(`pulled: no package.json found in ${cwd} or any parent directory\n`);
    return 2;
  }
  let report = await runAll(ctx);
  if (values.fix && !report.ok) {
    runFix(fixSteps(ctx, report), values.json === true);
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

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`pulled: internal error: ${(err as Error)?.stack ?? err}\n`);
    process.exitCode = 2;
  },
);
