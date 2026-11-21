import { join } from 'node:path';
import type { CheckResult, Context } from '../types';

const FILES = ['.nvmrc', '.node-version'];

/** `node`: compares the major version in .nvmrc / .node-version with the running Node. */
export function nodeCheck(ctx: Context): CheckResult {
  const dirs = ctx.rootDir === ctx.pkgDir ? [ctx.pkgDir] : [ctx.pkgDir, ctx.rootDir];
  for (const dir of dirs) {
    for (const file of FILES) {
      const raw = ctx.fs.read(join(dir, file));
      if (raw === undefined) continue;
      const value = raw.split(/\r?\n/)[0]?.trim() ?? '';
      const match = /^v?(\d+)(\.\d+){0,2}$/.exec(value);
      if (!match) return { issues: [], skip: `${file} contains "${value}", not a version number` };
      const expected = Number(match[1]);
      const actual = Number(ctx.nodeVersion.split('.')[0]);
      if (expected === actual) return { issues: [] };
      return {
        issues: [
          {
            id: 'node',
            title: `Project expects Node ${expected}, you're on ${ctx.nodeVersion}`,
            details: [],
            fix: file === '.nvmrc' ? 'nvm use' : `switch to Node ${expected}`,
          },
        ],
      };
    }
  }
  return { issues: [], skip: 'no .nvmrc or .node-version' };
}
