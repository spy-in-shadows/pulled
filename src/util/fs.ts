import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Fs } from '../types';

export const nodeFs: Fs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  exists: (path) => existsSync(path),
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
};

export function readJson<T>(fs: Fs, path: string): T | undefined {
  const text = fs.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
