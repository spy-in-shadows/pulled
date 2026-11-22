import { describe, expect, it } from 'vitest';
import { depsCheck } from '../src/checks/deps';
import { fixSteps, spawnArgs } from '../src/fix';
import type { Report } from '../src/types';
import { ctx, fixture } from './helpers';

// Lockfiles with one package and no node_modules: "Dependencies are not installed".
const lockfiles = {
  npm: {
    'package-lock.json': {
      lockfileVersion: 3,
      packages: { '': { dependencies: { zod: '^3' } }, 'node_modules/zod': { version: '3.0.0' } },
    },
  },
  pnpm: {
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\npackages:\n\n  zod@3.0.0:\n    resolution: {}\n",
  },
  yarn: {
    'yarn.lock':
      '# yarn lockfile v1\n\nzod@^3:\n  version "3.0.0"\n  resolved "https://r/zod-3.0.0.tgz"\n',
  },
};

/** The fix commands for a project with stale deps, Prisma client and migrations. */
function commands(pm: keyof typeof lockfiles): string[] {
  const dir = fixture({
    'package.json': { name: 'app', dependencies: { zod: '^3' } },
    ...lockfiles[pm],
  });
  const c = ctx(dir);
  const deps = depsCheck(c).issues;
  expect(deps).toHaveLength(1);
  const report: Report = {
    ok: false,
    issues: [
      ...deps,
      { id: 'prisma-client', title: 'x', details: [], fix: 'x' },
      { id: 'migrations', title: 'x', details: [], fix: 'x' },
    ],
    skipped: [],
  };
  return fixSteps(c, report).map(([command]) => command);
}

const expected = {
  npm: ['npm install', 'npx prisma generate', 'npx prisma migrate deploy'],
  pnpm: ['pnpm install', 'pnpm exec prisma generate', 'pnpm exec prisma migrate deploy'],
  yarn: ['yarn', 'yarn prisma generate', 'yarn prisma migrate deploy'],
};

describe('--fix commands', () => {
  it.each(Object.keys(expected) as (keyof typeof expected)[])('%s: fixed command strings', (pm) => {
    expect(commands(pm)).toEqual(expected[pm]);
  });

  const argv: Record<keyof typeof expected, [string, string[]][]> = {
    npm: [
      ['npm', ['install']],
      ['npx', ['prisma', 'generate']],
      ['npx', ['prisma', 'migrate', 'deploy']],
    ],
    pnpm: [
      ['pnpm', ['install']],
      ['pnpm', ['exec', 'prisma', 'generate']],
      ['pnpm', ['exec', 'prisma', 'migrate', 'deploy']],
    ],
    yarn: [
      ['yarn', []],
      ['yarn', ['prisma', 'generate']],
      ['yarn', ['prisma', 'migrate', 'deploy']],
    ],
  };

  it.each(Object.keys(expected) as (keyof typeof expected)[])(
    '%s: exact argv, no shell except on Windows',
    (pm) => {
      for (const platform of ['linux', 'darwin'] as const) {
        expect(commands(pm).map((cmd) => spawnArgs(cmd, platform))).toEqual(
          argv[pm].map(([bin, args]) => [bin, args, {}]),
        );
      }
      expect(commands(pm).map((cmd) => spawnArgs(cmd, 'win32'))).toEqual(
        expected[pm].map((cmd) => [cmd, [], { shell: true }]),
      );
    },
  );
});
