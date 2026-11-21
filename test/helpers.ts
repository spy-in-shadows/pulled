import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import type { Context } from '../src/types';
import { type ContextOptions, createContext } from '../src/util/context';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Creates a temp project from a { relativePath: contents } map. Objects are JSON-encoded. */
export function fixture(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'pulled-test-'));
  dirs.push(root);
  write(root, files);
  return root;
}

export function write(root: string, files: Record<string, string | object>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

export function remove(root: string, rel: string): void {
  rmSync(join(root, rel), { recursive: true, force: true });
}

/** Context for a fixture dir with an isolated env (never the real process.env). */
export function ctx(cwd: string, opts: Omit<ContextOptions, 'cwd'> = {}): Context {
  const c = createContext({ cwd, env: {}, nodeVersion: '22.11.0', ...opts });
  if (!c) throw new Error(`no package.json above ${cwd}`);
  return c;
}
