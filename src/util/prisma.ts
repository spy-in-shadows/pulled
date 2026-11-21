import { dirname, join, resolve } from 'node:path';
import type { Context } from '../types';

export interface Block {
  /** The .prisma file the block is in. */
  file: string;
  fields: Record<string, string>;
}

export interface PrismaProject {
  /** Every .prisma source file of the schema. */
  files: string[];
  generators: Block[];
  datasource?: Block;
  /** Text of prisma.config.*, if any (never executed). */
  config?: { dir: string; text: string };
}

const CONFIGS = ['prisma.config.ts', 'prisma.config.js', 'prisma.config.mjs'];

export function usesPrisma(ctx: Context): boolean {
  const { dependencies: d, devDependencies: dd, optionalDependencies: od } = ctx.pkg;
  return [d, dd, od].some((deps) => deps && ('prisma' in deps || '@prisma/client' in deps));
}

/** Exactly one distinct match of `re` (group 1 or the last group) in `text`, else undefined. */
export function single(text: string, re: RegExp): string | undefined {
  const found = new Set([...text.matchAll(re)].map((m) => m[m.length - 1] as string));
  return found.size === 1 ? [...found][0] : undefined;
}

export function loadPrisma(ctx: Context): PrismaProject | undefined {
  const { fs, pkgDir } = ctx;
  const configFile = CONFIGS.map((f) => join(pkgDir, f)).find((f) => fs.exists(f));
  const configText = configFile ? fs.read(configFile) : undefined;
  const config = configText === undefined ? undefined : { dir: pkgDir, text: configText };

  const candidates = [
    ctx.pkg.prisma?.schema,
    config && single(config.text, /\bschema\s*:\s*(["'])([^"'\n]+)\1/g),
    'prisma/schema.prisma',
    'prisma',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = resolve(pkgDir, candidate);
    const files = fs.isDir(path) ? prismaFiles(ctx, path) : fs.exists(path) ? [path] : [];
    if (files.length === 0) continue;
    const blocks = files.flatMap((file) => parseBlocks(file, fs.read(file) ?? ''));
    return {
      files,
      generators: blocks.filter((b) => b.kind === 'generator'),
      datasource: blocks.find((b) => b.kind === 'datasource'),
      config,
    };
  }
  return undefined;
}

function prismaFiles(ctx: Context, dir: string): string[] {
  return ctx.fs.list(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'migrations' || name === 'node_modules') return [];
    if (ctx.fs.isDir(path)) return prismaFiles(ctx, path);
    return name.endsWith('.prisma') ? [path] : [];
  });
}

/** Removes a `//` comment that isn't inside a string. */
function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') inString = !inString;
    else if (!inString && line.startsWith('//', i)) return line.slice(0, i);
  }
  return line;
}

function parseBlocks(file: string, text: string): (Block & { kind: string })[] {
  const clean = text.replace(/\r/g, '').split('\n').map(stripComment).join('\n');
  const blocks: (Block & { kind: string })[] = [];
  for (const m of clean.matchAll(/^\s*(generator|datasource)\s+\w+\s*\{([^}]*)\}/gm)) {
    const fields: Record<string, string> = {};
    for (const f of (m[2] as string).matchAll(/^\s*(\w+)\s*=\s*(.+?)\s*$/gm)) {
      fields[f[1] as string] = (f[2] as string).replace(/^"(.*)"$/, '$1');
    }
    blocks.push({ kind: m[1] as string, file, fields });
  }
  return blocks;
}

export const blockDir = (block: Block) => dirname(block.file);
