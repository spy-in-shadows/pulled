import { dirname, join } from 'node:path';
import type { CheckId, Config, Context, Fs, PackageJson, PackageManager } from '../types';
import { nodeFs, readJson } from './fs';

const CHECK_IDS: CheckId[] = ['deps', 'node', 'env', 'prisma-client', 'migrations'];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;

export interface ContextOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  fs?: Fs;
}

/** Builds the check context, or returns undefined when there's no package.json above cwd. */
export function createContext(opts: ContextOptions = {}): Context | undefined {
  const fs = opts.fs ?? nodeFs;
  const env = opts.env ?? process.env;
  const debug = (msg: string) => {
    if (env.PULLED_DEBUG && env.PULLED_DEBUG !== '0') process.stderr.write(`[pulled] ${msg}\n`);
  };

  const pkgDir = findUp(opts.cwd ?? process.cwd(), (d) => fs.exists(join(d, 'package.json')));
  if (!pkgDir) return undefined;
  const pkg = readJson<PackageJson>(fs, join(pkgDir, 'package.json')) ?? {};
  const rootDir = findRoot(fs, pkgDir);
  const rootPkg =
    rootDir === pkgDir ? pkg : (readJson<PackageJson>(fs, join(rootDir, 'package.json')) ?? {});
  const found = LOCKFILES.filter((f) => fs.exists(join(rootDir, f)));

  return {
    pkgDir,
    rootDir,
    pkg,
    lockfile: found.length === 1 ? found[0] : undefined,
    pm: detectPm(fs, rootDir, rootPkg, found),
    config: parseConfig(pkg.pulled, debug),
    env,
    nodeVersion: opts.nodeVersion ?? process.versions.node,
    fs,
    debug,
  };
}

function findUp(start: string, match: (dir: string) => boolean): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (match(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const hasLockfile = (fs: Fs, dir: string) => LOCKFILES.some((f) => fs.exists(join(dir, f)));

/**
 * The package dir if it has a lockfile; otherwise the nearest ancestor that has a lockfile AND
 * declares workspaces (so a stray lockfile in e.g. the home directory is never picked up).
 */
function findRoot(fs: Fs, pkgDir: string): string {
  if (hasLockfile(fs, pkgDir)) return pkgDir;
  const root = findUp(dirname(pkgDir), (dir) => {
    if (!hasLockfile(fs, dir)) return false;
    if (fs.exists(join(dir, 'pnpm-workspace.yaml'))) return true;
    return readJson<PackageJson>(fs, join(dir, 'package.json'))?.workspaces !== undefined;
  });
  return root ?? pkgDir;
}

function detectPm(fs: Fs, rootDir: string, rootPkg: PackageJson, lockfiles: string[]) {
  const declared = /^(npm|pnpm|yarn)@(\d+)/.exec(rootPkg.packageManager ?? '');
  let pm: PackageManager = 'npm';
  if (declared) pm = declared[1] as PackageManager;
  else if (lockfiles.length === 1 && lockfiles[0] === 'pnpm-lock.yaml') pm = 'pnpm';
  else if (lockfiles.length === 1 && lockfiles[0] === 'yarn.lock') pm = 'yarn';
  if (pm === 'yarn') {
    const berry =
      (declared && Number(declared[2]) >= 2) ||
      fs.exists(join(rootDir, '.yarnrc.yml')) ||
      /^__metadata:/m.test(fs.read(join(rootDir, 'yarn.lock')) ?? '');
    if (berry) pm = 'yarn-berry';
  }
  return pm;
}

function parseConfig(raw: unknown, debug: (msg: string) => void): Config {
  const config: Config = { skip: [], strict: false };
  if (raw === undefined) return config;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    debug('package.json "pulled" config must be an object; ignoring it');
    return config;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'skip' && Array.isArray(value)) {
      for (const id of value) {
        if (CHECK_IDS.includes(id)) config.skip.push(id);
        else debug(`config.skip: unknown check id ${JSON.stringify(id)}`);
      }
    } else if (key === 'strict' && typeof value === 'boolean') config.strict = value;
    else if (key === 'envExample' && typeof value === 'string') config.envExample = value;
    else if (key === 'skip' || key === 'strict' || key === 'envExample')
      debug(`config.${key} has an invalid value; ignoring it`);
    else debug(`unknown config key "${key}"; ignoring it`);
  }
  return config;
}

/** Command prefix to run a project binary with the detected package manager. */
export function execCmd(pm: PackageManager, bin: string): string {
  if (pm === 'pnpm') return `pnpm exec ${bin}`;
  if (pm === 'yarn' || pm === 'yarn-berry') return `yarn ${bin}`;
  return `npx ${bin}`;
}

/** Import mode is off in production, on CI, or with PULLED=0/false/off. */
export function importModeDisabled(env: Record<string, string | undefined>): boolean {
  const ci = env.CI?.toLowerCase();
  return (
    env.NODE_ENV === 'production' ||
    (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') ||
    ['0', 'false', 'off'].includes(env.PULLED?.toLowerCase() ?? '')
  );
}
