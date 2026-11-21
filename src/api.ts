import type { Report } from './types';

export type { CheckId, Issue, Report } from './types';

// Placeholder until Phase 3 wires up the checks.
export async function check(): Promise<Report> {
  return { ok: true, issues: [], skipped: [] };
}
