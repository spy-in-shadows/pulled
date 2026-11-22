export type CheckId = 'deps' | 'node' | 'env' | 'prisma-client' | 'migrations';

export interface Issue {
  id: CheckId;
  title: string;
  details: string[];
  fix?: string;
}

export interface Report {
  ok: boolean;
  issues: Issue[];
  skipped: { id: CheckId; reason: string }[];
}

/** What a single check returns: zero or more issues, or a reason it didn't run. */
export interface CheckResult {
  issues: Issue[];
  skip?: string;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry';

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
  prisma?: { schema?: string };
  pulled?: unknown;
}

export interface Config {
  skip: CheckId[];
  strict: boolean;
  envExample?: string;
}

/** Minimal filesystem surface the checks use, injectable for tests. */
export interface Fs {
  /** File contents, or undefined if it can't be read. */
  read(path: string): string | undefined;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  /** Directory entries (names), or [] if it can't be read. */
  list(path: string): string[];
  realpath(path: string): string | undefined;
}

export interface Context {
  /** Directory of the nearest package.json. */
  pkgDir: string;
  /** Directory holding the lockfile / node_modules (workspace root), or pkgDir. */
  rootDir: string;
  pkg: PackageJson;
  /** Lockfile name found in rootDir, if exactly one. */
  lockfile?: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';
  pm: PackageManager;
  config: Config;
  env: Record<string, string | undefined>;
  nodeVersion: string;
  fs: Fs;
  debug: (msg: string) => void;
  /** Import mode: the migrations query must not keep the host process alive. */
  background: boolean;
}
