// Runs the checks and collects their results into a Report. Used by the CLI, import mode and api.
import { depsCheck } from './checks/deps';
import { envCheck } from './checks/env';
import { migrationsCheck } from './checks/migrations';
import { nodeCheck } from './checks/node';
import { prismaClientCheck } from './checks/prismaClient';
import type { CheckId, CheckResult, Context, Report } from './types';

/** Synchronous checks, in the order their issues are reported. */
const SYNC_CHECKS: [CheckId, (ctx: Context) => CheckResult][] = [
  ['deps', depsCheck],
  ['node', nodeCheck],
  ['prisma-client', prismaClientCheck],
  ['env', envCheck],
];

export const empty = (): Report => ({ ok: true, issues: [], skipped: [] });

function add(report: Report, id: CheckId, result: CheckResult): void {
  report.issues.push(...result.issues);
  if (result.skip !== undefined) report.skipped.push({ id, reason: result.skip });
  report.ok = report.issues.length === 0;
}

function skippedByConfig(ctx: Context, report: Report, id: CheckId): boolean {
  if (!ctx.config.skip.includes(id)) return false;
  report.skipped.push({ id, reason: 'skipped in config' });
  return true;
}

/** Runs one check and never throws: an internal error becomes a skip (details under PULLED_DEBUG). */
function failed(ctx: Context, id: CheckId, err: unknown): CheckResult {
  ctx.debug(`${id}: internal error: ${(err as Error)?.stack ?? err}`);
  return { issues: [], skip: 'internal error' };
}

/** The synchronous checks (everything but `migrations`). */
export function runSync(ctx: Context): Report {
  const report = empty();
  for (const [id, run] of SYNC_CHECKS) {
    if (skippedByConfig(ctx, report, id)) continue;
    const start = performance.now();
    let result: CheckResult;
    try {
      result = run(ctx);
    } catch (err) {
      result = failed(ctx, id, err);
    }
    ctx.debug(`${id}: ${(performance.now() - start).toFixed(1)} ms${skipNote(result)}`);
    add(report, id, result);
  }
  return report;
}

/** The async `migrations` check, as its own report. */
export async function runMigrations(ctx: Context): Promise<Report> {
  const report = empty();
  if (skippedByConfig(ctx, report, 'migrations')) return report;
  const start = performance.now();
  let result: CheckResult;
  try {
    result = await migrationsCheck(ctx);
  } catch (err) {
    result = failed(ctx, 'migrations', err);
  }
  ctx.debug(`migrations: ${(performance.now() - start).toFixed(1)} ms${skipNote(result)}`);
  add(report, 'migrations', result);
  return report;
}

const skipNote = (r: CheckResult) => (r.skip === undefined ? '' : ` (skipped: ${r.skip})`);

/** Every check, sync and async, as one report. */
export async function runAll(ctx: Context): Promise<Report> {
  const report = runSync(ctx);
  const migrations = await runMigrations(ctx);
  add(report, 'migrations', { issues: migrations.issues });
  report.skipped.push(...migrations.skipped);
  return report;
}
