import { empty, runAll } from './run';
import type { Report } from './types';
import { createContext } from './util/context';

export type { CheckId, Issue, Report } from './types';

/** Runs every check for the project at `cwd` (default: process.cwd()). Never rejects. */
export async function check(options: { cwd?: string } = {}): Promise<Report> {
  try {
    const ctx = createContext({ cwd: options.cwd });
    return ctx ? await runAll(ctx) : empty();
  } catch {
    return empty();
  }
}
