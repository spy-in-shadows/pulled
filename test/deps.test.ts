import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { depsCheck } from '../src/checks/deps';
import { ctx, fixture, remove, write } from './helpers';

type Entry = {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  link?: boolean;
};

/** Builds a package-lock.json v3 from { "node_modules/x": entry } plus the root entry. */
function npmLock(packages: Record<string, Entry>, root: object = {}) {
  return {
    name: 'app',
    lockfileVersion: 3,
    packages: { '': { name: 'app', ...root }, ...packages },
  };
}

/** Simulates `npm install`: writes each installed package and the hidden lockfile. */
function npmInstall(dir: string, installed: Record<string, Entry>) {
  const files: Record<string, object> = {
    'node_modules/.package-lock.json': { lockfileVersion: 3, packages: installed },
  };
  for (const [path, e] of Object.entries(installed)) {
    // Only real installs; '' is the root entry and workspace folders keep their own package.json.
    if (!e.link && path.includes('node_modules/'))
      files[`${path}/package.json`] = { version: e.version };
  }
  write(dir, files);
}

const express = { version: '4.21.1' };
const zod = { version: '3.23.8' };
const pkg = { name: 'app', dependencies: { express: '^4.21.1', zod: '^3.23.8' } };
const lockRoot = { dependencies: pkg.dependencies };
const lock = npmLock({ 'node_modules/express': express, 'node_modules/zod': zod }, lockRoot);

function npmProject(files: Record<string, string | object> = {}) {
  return fixture({ 'package.json': pkg, 'package-lock.json': lock, ...files });
}

describe('deps check: npm', () => {
  it('is silent when node_modules matches the lockfile', () => {
    const dir = npmProject();
    npmInstall(dir, lock.packages as Record<string, Entry>);
    expect(depsCheck(ctx(dir))).toEqual({ issues: [] });
  });

  it('reports missing node_modules', () => {
    const dir = npmProject();
    expect(depsCheck(ctx(dir)).issues).toEqual([
      { id: 'deps', title: 'Dependencies are not installed', details: [], fix: 'npm install' },
    ]);
  });

  it('is silent without node_modules when there is nothing to install', () => {
    const dir = fixture({ 'package.json': { name: 'app' }, 'package-lock.json': npmLock({}) });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports stale and missing packages with installed → expected examples', () => {
    const dir = npmProject();
    npmInstall(dir, { 'node_modules/express': { version: '4.19.2' } });
    expect(depsCheck(ctx(dir)).issues).toEqual([
      {
        id: 'deps',
        title: 'Dependencies: 2 packages differ from package-lock.json',
        details: ['express 4.19.2 → 4.21.1, zod (not installed)'],
        fix: 'npm install',
      },
    ]);
  });

  it('limits examples to 3, direct deps first, plus a count', () => {
    const packages: Record<string, Entry> = {
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/express': express,
      'node_modules/c': { version: '1.0.0' },
      'node_modules/c/node_modules/d': { version: '2.0.0' },
    };
    const dir = fixture({ 'package.json': pkg, 'package-lock.json': npmLock(packages, lockRoot) });
    npmInstall(dir, { 'node_modules/zzz': { version: '1.0.0' } });
    const [issue] = depsCheck(ctx(dir)).issues;
    expect(issue?.title).toBe('Dependencies: 5 packages differ from package-lock.json');
    expect(issue?.details).toEqual([
      'express (not installed), a (not installed), b (not installed), +2 more',
    ]);
  });

  it('trusts the real package.json when the hidden lockfile is outdated or missing', () => {
    const dir = npmProject();
    npmInstall(dir, lock.packages as Record<string, Entry>);
    write(dir, {
      'node_modules/.package-lock.json': {
        packages: { 'node_modules/express': { version: '1.0.0' } },
      },
    });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
    remove(dir, 'node_modules/.package-lock.json');
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('ignores optional platform binaries that are not installed (esbuild)', () => {
    const platforms = ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'];
    const packages: Record<string, Entry> = { 'node_modules/esbuild': { version: '0.24.0' } };
    for (const p of platforms)
      packages[`node_modules/@esbuild/${p}`] = { version: '0.24.0', optional: true };
    packages['node_modules/fsevents'] = { version: '2.3.3', dev: true, devOptional: true } as Entry;
    const dir = fixture({
      'package.json': { name: 'app' },
      'package-lock.json': npmLock(packages),
    });
    npmInstall(dir, {
      'node_modules/esbuild': { version: '0.24.0' },
      'node_modules/@esbuild/darwin-arm64': { version: '0.24.0', optional: true },
    });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('still reports an optional package installed at the wrong version', () => {
    const packages = {
      'node_modules/@esbuild/darwin-arm64': { version: '0.24.0', optional: true },
    };
    const dir = fixture({
      'package.json': { name: 'app' },
      'package-lock.json': npmLock(packages),
    });
    npmInstall(dir, { 'node_modules/@esbuild/darwin-arm64': { version: '0.23.0' } });
    expect(depsCheck(ctx(dir)).issues[0]?.details).toEqual([
      '@esbuild/darwin-arm64 0.23.0 → 0.24.0',
    ]);
  });

  it('ignores uninstalled dev deps when dev deps were omitted on purpose (omit=dev)', () => {
    const packages = {
      'node_modules/ms': { version: '2.1.3' },
      'node_modules/vitest': { version: '4.1.12', dev: true },
    };
    const dir = fixture({
      'package.json': { name: 'app' },
      'package-lock.json': npmLock(packages),
    });
    npmInstall(dir, { 'node_modules/ms': { version: '2.1.3' } });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports a new dev dep when other dev deps are installed', () => {
    const packages = {
      'node_modules/tsup': { version: '8.5.1', dev: true },
      'node_modules/vitest': { version: '4.1.12', dev: true },
    };
    const dir = fixture({
      'package.json': { name: 'app' },
      'package-lock.json': npmLock(packages),
    });
    npmInstall(dir, { 'node_modules/tsup': { version: '8.5.1', dev: true } });
    expect(depsCheck(ctx(dir)).issues[0]?.details).toEqual(['vitest (not installed)']);
  });

  it('skips link entries and workspace folders that match on disk', () => {
    const dir = fixture({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'package-lock.json': npmLock({
        'node_modules/a': { link: true },
        'packages/a': { version: '1.2.4' },
      }),
      'packages/a/package.json': { name: 'a', version: '1.2.4' },
    });
    npmInstall(dir, { 'node_modules/a': { link: true }, 'packages/a': { version: '1.2.3' } });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('uses the workspace root lockfile from inside a workspace package', () => {
    const dir = fixture({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'package-lock.json': npmLock({ 'node_modules/zod': zod, 'packages/a': { version: '1.0.0' } }),
      'packages/a/package.json': { name: 'a', version: '1.0.0' },
    });
    npmInstall(dir, { 'packages/a': { version: '1.0.0' } });
    const result = depsCheck(ctx(join(dir, 'packages/a')));
    expect(result.issues[0]?.details).toEqual(['zod (not installed)']);
  });

  it('reports deps added to package.json but missing from the lockfile', () => {
    const dir = npmProject({
      'package.json': { ...pkg, devDependencies: { vitest: '^4' } },
    });
    npmInstall(dir, lock.packages as Record<string, Entry>);
    expect(depsCheck(ctx(dir)).issues).toEqual([
      {
        id: 'deps',
        title: "package.json changed but the lockfile wasn't updated",
        details: ['vitest'],
        fix: 'npm install',
      },
    ]);
  });

  it('is silent again after the user runs npm install', () => {
    const dir = npmProject();
    npmInstall(dir, { 'node_modules/express': { version: '4.19.2' } });
    expect(depsCheck(ctx(dir)).issues).toHaveLength(1);
    npmInstall(dir, lock.packages as Record<string, Entry>);
    expect(depsCheck(ctx(dir)).issues).toHaveLength(0);
  });

  it('skips lockfile v1', () => {
    const dir = fixture({
      'package.json': pkg,
      'package-lock.json': { lockfileVersion: 1, dependencies: {} },
    });
    expect(depsCheck(ctx(dir)).skip).toBe('package-lock.json v1 is not supported');
  });
});

describe('deps check: lockfile detection', () => {
  it('skips without a lockfile', () => {
    expect(depsCheck(ctx(fixture({ 'package.json': pkg }))).skip).toBe('no lockfile');
  });

  it('skips with multiple lockfiles', () => {
    const dir = fixture({ 'package.json': pkg, 'package-lock.json': lock, 'yarn.lock': '' });
    expect(depsCheck(ctx(dir)).skip).toBe(
      'multiple lockfiles found (package-lock.json, yarn.lock)',
    );
  });

  it('ignores a stray lockfile in a parent dir that is not a workspace root', () => {
    const dir = fixture({
      'package.json': { name: 'home' },
      'package-lock.json': lock,
      'app/package.json': pkg,
    });
    expect(depsCheck(ctx(join(dir, 'app'))).skip).toBe('no lockfile');
  });

  it.each([
    ['packageManager', { 'package.json': { packageManager: 'yarn@4.5.0' }, 'yarn.lock': '' }],
    ['.yarnrc.yml', { 'package.json': {}, 'yarn.lock': '', '.yarnrc.yml': '' }],
    ['lockfile format', { 'package.json': {}, 'yarn.lock': '__metadata:\n  version: 8\n' }],
  ])('skips yarn berry detected via %s', (_, files) => {
    expect(depsCheck(ctx(fixture(files))).skip).toBe('yarn berry not supported yet');
  });
});

const pnpmLock =
  "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      zod:\n        specifier: 3.23.8\n        version: 3.23.8\n\npackages:\n\n  zod@3.23.8:\n    resolution: {integrity: sha512-x}\n";
const pnpmLockNew = pnpmLock.replaceAll('3.23.8', '3.24.0');
const modulesYaml = (dev: boolean) =>
  JSON.stringify({
    included: { dependencies: true, devDependencies: dev, optionalDependencies: true },
    hoistedDependencies: {},
  });

describe('deps check: pnpm', () => {
  const project = (installedLock: string | undefined, dev = true) => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify(pkg),
      'pnpm-lock.yaml': pnpmLockNew,
    };
    if (installedLock !== undefined) {
      files['node_modules/.pnpm/lock.yaml'] = installedLock;
      files['node_modules/.modules.yaml'] = modulesYaml(dev);
    }
    return fixture(files);
  };

  it('is silent when the installed copy matches', () => {
    expect(depsCheck(ctx(project(pnpmLockNew)))).toEqual({ issues: [] });
  });

  it('is silent when only line endings differ (CRLF checkout)', () => {
    const dir = project(pnpmLockNew);
    write(dir, { 'pnpm-lock.yaml': pnpmLockNew.replace(/\n/g, '\r\n') });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports a changed lockfile', () => {
    expect(depsCheck(ctx(project(pnpmLock))).issues).toEqual([
      {
        id: 'deps',
        title: 'Dependencies: pnpm-lock.yaml changed since the last install',
        details: [],
        fix: 'pnpm install',
      },
    ]);
  });

  it('reports missing node_modules', () => {
    expect(depsCheck(ctx(project(undefined))).issues[0]?.title).toBe(
      'Dependencies are not installed',
    );
  });

  it('stays silent after a filtered (--prod) install', () => {
    expect(depsCheck(ctx(project(pnpmLock, false)))).toEqual({
      issues: [],
      skip: 'filtered pnpm install (dev or optional dependencies excluded)',
    });
  });

  it('reads the pnpm 9 YAML form of .modules.yaml', () => {
    const dir = project(pnpmLock);
    write(dir, {
      'node_modules/.modules.yaml': 'included:\n  dependencies: true\n  devDependencies: false\n',
    });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('skips node_modules that pnpm did not install', () => {
    const dir = project(undefined);
    write(dir, { 'node_modules/zod/package.json': '{}' });
    expect(depsCheck(ctx(dir)).skip).toBe('node_modules was not installed by pnpm');
  });

  it('is silent again after the user runs pnpm install', () => {
    const dir = project(pnpmLock);
    expect(depsCheck(ctx(dir)).issues).toHaveLength(1);
    write(dir, { 'node_modules/.pnpm/lock.yaml': pnpmLockNew });
    expect(depsCheck(ctx(dir)).issues).toHaveLength(0);
  });
});

const yarnLock = (
  expressVersion: string,
) => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@scope/pkg@^1.0.0":
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.0.0.tgz#aaa"

express@${expressVersion}:
  version "${expressVersion}"
  resolved "https://registry.yarnpkg.com/express/-/express-${expressVersion}.tgz#bbb"
  dependencies:
    ms "2.1.3"

ms@2.1.3, ms@^2.1.0:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#ccc"

local@file:./local:
  version "0.0.1"
`;

const integrity = (expressVersion: string, extra: Record<string, string> = {}) => ({
  flags: [],
  lockfileEntries: {
    '@scope/pkg@^1.0.0': 'https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.0.0.tgz#aaa',
    [`express@${expressVersion}`]: `https://registry.yarnpkg.com/express/-/express-${expressVersion}.tgz#bbb`,
    'ms@2.1.3': 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#ccc',
    'ms@^2.1.0': 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#ccc',
    ...extra,
  },
});

describe('deps check: yarn v1', () => {
  const project = (installed?: object) =>
    fixture({
      'package.json': pkg,
      'yarn.lock': yarnLock('4.21.1'),
      ...(installed ? { 'node_modules/.yarn-integrity': installed } : {}),
    });

  it('is silent when lockfileEntries match yarn.lock', () => {
    expect(depsCheck(ctx(project(integrity('4.21.1'))))).toEqual({ issues: [] });
  });

  it('is silent with a CRLF yarn.lock', () => {
    const dir = project(integrity('4.21.1'));
    write(dir, { 'yarn.lock': yarnLock('4.21.1').replace(/\n/g, '\r\n') });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports changed packages with versions', () => {
    expect(depsCheck(ctx(project(integrity('4.19.2')))).issues).toEqual([
      {
        id: 'deps',
        title: 'Dependencies: 1 package differs from yarn.lock',
        details: ['express 4.19.2 → 4.21.1'],
        fix: 'yarn',
      },
    ]);
  });

  it('reports packages no longer in the lockfile', () => {
    const installed = integrity('4.21.1', {
      'left-pad@^1.0.0': 'https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#d',
    });
    expect(depsCheck(ctx(project(installed))).issues[0]?.details).toEqual(['left-pad (removed)']);
  });

  it('ignores a new range that resolves to an already-installed tarball', () => {
    const dir = project(integrity('4.21.1'));
    write(dir, {
      'yarn.lock': yarnLock('4.21.1').replace('ms@2.1.3, ms@^2.1.0', 'ms@2.1.3, ms@^2.1.1'),
    });
    expect(depsCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports missing node_modules', () => {
    expect(depsCheck(ctx(project())).issues[0]).toMatchObject({
      title: 'Dependencies are not installed',
      fix: 'yarn',
    });
  });

  it('skips node_modules that yarn did not install', () => {
    const dir = project();
    write(dir, { 'node_modules/express/package.json': '{}' });
    expect(depsCheck(ctx(dir)).skip).toBe('node_modules was not installed by yarn');
  });

  it('is silent again after the user runs yarn', () => {
    const dir = project(integrity('4.19.2'));
    expect(depsCheck(ctx(dir)).issues).toHaveLength(1);
    write(dir, { 'node_modules/.yarn-integrity': integrity('4.21.1') });
    expect(depsCheck(ctx(dir)).issues).toHaveLength(0);
  });
});
