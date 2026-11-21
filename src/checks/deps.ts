import { join, relative } from 'node:path';
import type { CheckResult, Context, Issue, PackageJson } from '../types';
import { readJson } from '../util/fs';

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface LockEntry {
  name?: string;
  version?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Stale {
  name: string;
  /** Not installed at all. */
  absent?: boolean;
  installed?: string;
  /** Undefined when the package is no longer in the lockfile. */
  expected?: string;
}

/** `deps`: node_modules vs the lockfile. */
export function depsCheck(ctx: Context): CheckResult {
  if (ctx.pm === 'yarn-berry') return skip('yarn berry not supported yet');
  if (!ctx.lockfile) {
    const many = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter((f) =>
      ctx.fs.exists(join(ctx.rootDir, f)),
    );
    return skip(many.length > 1 ? `multiple lockfiles found (${many.join(', ')})` : 'no lockfile');
  }
  if (ctx.lockfile === 'package-lock.json') return npm(ctx);
  if (ctx.lockfile === 'pnpm-lock.yaml') return pnpm(ctx);
  return yarn(ctx);
}

const skip = (reason: string): CheckResult => ({ issues: [], skip: reason });

function installCmd(ctx: Context): string {
  return ctx.pm === 'pnpm' ? 'pnpm install' : ctx.pm === 'yarn' ? 'yarn' : 'npm install';
}

function issue(ctx: Context, title: string, details: string[] = []): CheckResult {
  return { issues: [{ id: 'deps', title, details, fix: installCmd(ctx) } satisfies Issue] };
}

const notInstalled = (ctx: Context) => issue(ctx, 'Dependencies are not installed');

function summary(ctx: Context, stale: Stale[], lockfile: string): CheckResult {
  const direct = new Set(FIELDS.flatMap((f) => Object.keys(ctx.pkg[f] ?? {})));
  const sorted = [...stale].sort((a, b) => Number(direct.has(b.name)) - Number(direct.has(a.name)));
  const examples = sorted.slice(0, 3).map(({ name, absent, installed, expected }) => {
    if (absent) return `${name} (not installed)`;
    if (expected === undefined) return `${name} (removed)`;
    return installed === undefined ? `${name} → ${expected}` : `${name} ${installed} → ${expected}`;
  });
  if (stale.length > 3) examples.push(`+${stale.length - 3} more`);
  const count = stale.length === 1 ? '1 package differs' : `${stale.length} packages differ`;
  return issue(ctx, `Dependencies: ${count} from ${lockfile}`, [examples.join(', ')]);
}

function npm(ctx: Context): CheckResult {
  const { fs, rootDir } = ctx;
  const lock = readJson<{ lockfileVersion?: number; packages?: Record<string, LockEntry> }>(
    fs,
    join(rootDir, 'package-lock.json'),
  );
  if (!lock?.packages || (lock.lockfileVersion ?? 1) < 2) {
    return skip('package-lock.json v1 is not supported');
  }
  const entries = Object.entries(lock.packages).filter(([path, e]) => path !== '' && !e.link);
  const result: CheckResult = { issues: [] };

  const unlocked = unlockedDeps(ctx, lock.packages);
  if (unlocked.length > 0) {
    const shown =
      unlocked.slice(0, 3).join(', ') +
      (unlocked.length > 3 ? `, +${unlocked.length - 3} more` : '');
    result.issues.push(
      ...issue(ctx, "package.json changed but the lockfile wasn't updated", [shown]).issues,
    );
  }

  if (!fs.isDir(join(rootDir, 'node_modules'))) {
    if (entries.length > 0) result.issues.push(...notInstalled(ctx).issues);
    return result;
  }

  const hidden =
    readJson<{ packages?: Record<string, LockEntry> }>(
      fs,
      join(rootDir, 'node_modules/.package-lock.json'),
    )?.packages ?? {};
  // Dev deps left out on purpose (omit=dev, NODE_ENV=production): none of them are in the hidden lockfile.
  const devPaths = entries.filter(([, e]) => e.dev).map(([path]) => path);
  const devOmitted = devPaths.length > 0 && !devPaths.some((p) => p in hidden);

  const stale: Stale[] = [];
  for (const [path, entry] of entries) {
    if (!entry.version || hidden[path]?.version === entry.version) continue;
    const installed = readJson<{ version?: string }>(
      fs,
      join(rootDir, path, 'package.json'),
    )?.version;
    if (installed === entry.version) continue;
    if (
      installed === undefined &&
      (entry.optional || entry.devOptional || (entry.dev && devOmitted))
    ) {
      continue;
    }
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    stale.push({ name, absent: installed === undefined, installed, expected: entry.version });
  }
  if (stale.length > 0) result.issues.push(...summary(ctx, stale, 'package-lock.json').issues);
  return result;
}

/** Direct deps in package.json (root and, in a workspace, this package) missing from the lockfile. */
function unlockedDeps(ctx: Context, packages: Record<string, LockEntry>): string[] {
  const pkgs: [PackageJson, LockEntry | undefined][] = [];
  const rootPkg =
    ctx.rootDir === ctx.pkgDir
      ? ctx.pkg
      : readJson<PackageJson>(ctx.fs, join(ctx.rootDir, 'package.json'));
  if (rootPkg) pkgs.push([rootPkg, packages['']]);
  if (ctx.rootDir !== ctx.pkgDir) {
    pkgs.push([ctx.pkg, packages[relative(ctx.rootDir, ctx.pkgDir).split('\\').join('/')]]);
  }
  const missing: string[] = [];
  for (const [pkg, locked] of pkgs) {
    if (!locked) continue;
    for (const field of FIELDS) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (!locked[field]?.[name] && !missing.includes(name)) missing.push(name);
      }
    }
  }
  return missing;
}

function pnpm(ctx: Context): CheckResult {
  const { fs, rootDir } = ctx;
  const lock = (fs.read(join(rootDir, 'pnpm-lock.yaml')) ?? '').replace(/\r/g, '');
  if (!fs.isDir(join(rootDir, 'node_modules'))) {
    return /^packages:\s*\n\s+\S/m.test(lock) ? notInstalled(ctx) : { issues: [] };
  }
  const copy = fs.read(join(rootDir, 'node_modules/.pnpm/lock.yaml'));
  if (copy === undefined) return skip('node_modules was not installed by pnpm');
  if (copy.replace(/\r/g, '') === lock) return { issues: [] };
  const modules = fs.read(join(rootDir, 'node_modules/.modules.yaml')) ?? '';
  if (/["']?(devDependencies|optionalDependencies)["']?\s*:\s*false/.test(modules)) {
    return skip('filtered pnpm install (dev or optional dependencies excluded)');
  }
  return issue(ctx, 'Dependencies: pnpm-lock.yaml changed since the last install');
}

interface YarnEntry {
  resolved?: string;
  version?: string;
}

/** yarn.lock v1 → { pattern: { resolved, version } }. */
export function parseYarnLock(text: string): Map<string, YarnEntry> {
  const map = new Map<string, YarnEntry>();
  let current: YarnEntry | undefined;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      current = {};
      for (const p of line.slice(0, -1).split(/,\s*/)) map.set(p.replace(/^"|"$/g, ''), current);
      continue;
    }
    const m = current && /^ {2}(resolved|version) "?([^"]*)"?$/.exec(line);
    if (current && m) current[m[1] as 'resolved' | 'version'] = m[2];
  }
  return map;
}

const yarnName = (pattern: string) => pattern.slice(0, pattern.indexOf('@', 1));
const urlVersion = (url: string) => /\/-\/.+?-(\d+\.\d+\.\d+[^/#]*?)\.tgz/.exec(url)?.[1];

function yarn(ctx: Context): CheckResult {
  const { fs, rootDir } = ctx;
  const lock = parseYarnLock(fs.read(join(rootDir, 'yarn.lock')) ?? '');
  if (!fs.isDir(join(rootDir, 'node_modules'))) {
    return lock.size > 0 ? notInstalled(ctx) : { issues: [] };
  }
  const integrity = readJson<{ lockfileEntries?: Record<string, string> }>(
    fs,
    join(rootDir, 'node_modules/.yarn-integrity'),
  );
  if (!integrity?.lockfileEntries) return skip('node_modules was not installed by yarn');
  const installed = integrity.lockfileEntries;

  // Installed version per package name (a changed range in package.json changes the pattern key).
  const installedByName = new Map<string, string | undefined>();
  for (const [pattern, url] of Object.entries(installed)) {
    installedByName.set(yarnName(pattern), urlVersion(url));
  }
  const installedUrls = new Set(Object.values(installed));
  const stale = new Map<string, Stale>();
  for (const [pattern, entry] of lock) {
    // Same tarball already installed under another pattern → nothing to do.
    if (!entry.resolved || installedUrls.has(entry.resolved)) continue;
    const name = yarnName(pattern);
    const absent = !installedByName.has(name);
    stale.set(name, {
      name,
      absent,
      installed: installedByName.get(name),
      expected: entry.version,
    });
  }
  // Packages removed from the lockfile entirely.
  const locked = new Set([...lock.keys()].map(yarnName));
  for (const [pattern, url] of Object.entries(installed)) {
    const name = yarnName(pattern);
    if (!locked.has(name)) stale.set(name, { name, installed: urlVersion(url) });
  }
  return stale.size > 0 ? summary(ctx, [...stale.values()], 'yarn.lock') : { issues: [] };
}
