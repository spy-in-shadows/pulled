import { describe, expect, it, vi } from 'vitest';
import { check } from '../src/api';
import { runAll, runSync } from '../src/run';
import { importModeDisabled } from '../src/util/context';
import { ctx, fixture } from './helpers';

const outOfSync = () =>
  fixture({
    'package.json': { name: 'app' },
    '.nvmrc': '18',
    '.env.example': 'API_KEY=\n',
    '.env': 'OTHER=1\n',
  });

describe('runSync / runAll', () => {
  it('collects issues and skip reasons', () => {
    const report = runSync(ctx(outOfSync()));
    expect(report.ok).toBe(false);
    expect(report.issues.map((i) => i.id)).toEqual(['node', 'env']);
    expect(report.skipped).toEqual([
      { id: 'deps', reason: 'no lockfile' },
      { id: 'prisma-client', reason: 'prisma is not a dependency' },
    ]);
  });

  it('is ok and silent when in sync', async () => {
    const dir = fixture({ 'package.json': { name: 'app' }, '.nvmrc': '22' });
    const report = await runAll(ctx(dir));
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.skipped.map((s) => s.id)).toEqual(['deps', 'prisma-client', 'env', 'migrations']);
  });

  it('honors config.skip', async () => {
    const dir = outOfSync();
    const c = ctx(dir);
    c.config.skip = ['node', 'migrations'];
    const report = await runAll(c);
    expect(report.issues.map((i) => i.id)).toEqual(['env']);
    expect(report.skipped).toContainEqual({ id: 'node', reason: 'skipped in config' });
    expect(report.skipped).toContainEqual({ id: 'migrations', reason: 'skipped in config' });
  });

  it('turns a crashing check into a skip and never throws', () => {
    const c = ctx(outOfSync());
    c.fs = {
      ...c.fs,
      read: () => {
        throw new Error('boom');
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const report = runSync(c);
    stderr.mockRestore();
    expect(report.skipped).toContainEqual({ id: 'node', reason: 'internal error' });
  });
});

describe('check()', () => {
  it('runs every check for cwd', async () => {
    const report = await check({ cwd: outOfSync() });
    expect(report.issues.map((i) => i.id)).toEqual(['node', 'env']);
  });
});

describe('importModeDisabled', () => {
  it.each([
    [{}, false],
    [{ NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'production' }, true],
    [{ CI: 'true' }, true],
    [{ CI: '1' }, true],
    [{ CI: 'false' }, false],
    [{ CI: '0' }, false],
    [{ CI: '' }, false],
    [{ PULLED: '0' }, true],
    [{ PULLED: 'false' }, true],
    [{ PULLED: 'OFF' }, true],
    [{ PULLED: '1' }, false],
  ])('%j → %s', (env, expected) => {
    expect(importModeDisabled(env)).toBe(expected);
  });
});
