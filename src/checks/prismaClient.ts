import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { CheckResult, Context } from '../types';
import { execCmd } from '../util/context';
import { blockDir, loadPrisma, usesPrisma } from '../util/prisma';

const CLASS_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `internal/class.${ext}`);

type Generated = { schema: string } | { never: true } | { skip: string };

/** `prisma-client`: the schema embedded in the generated client vs the schema source files. */
export function prismaClientCheck(ctx: Context): CheckResult {
  if (!usesPrisma(ctx)) return { issues: [], skip: 'prisma is not a dependency' };
  const project = loadPrisma(ctx);
  if (!project) return { issues: [], skip: 'no Prisma schema found' };
  const clients = project.generators.filter((g) =>
    ['prisma-client', 'prisma-client-js'].includes(g.fields.provider ?? ''),
  );
  if (clients.length === 0) return { issues: [], skip: 'no prisma-client generator' };

  const sources = project.files.flatMap((f) => lines(ctx.fs.read(f) ?? ''));
  const fix = `${execCmd(ctx.pm, 'prisma')} generate`;
  for (const gen of clients) {
    const generated = readGenerated(ctx, gen.fields.provider === 'prisma-client', gen);
    if ('skip' in generated) return { issues: [], skip: generated.skip };
    if ('never' in generated) {
      return {
        issues: [
          { id: 'prisma-client', title: 'Prisma client was never generated', details: [], fix },
        ],
      };
    }
    if (!sameLines(sources, lines(generated.schema))) {
      const title = 'Prisma schema changed since the client was generated';
      return { issues: [{ id: 'prisma-client', title, details: [], fix }] };
    }
  }
  return { issues: [] };
}

/**
 * The schema as whitespace-stripped lines, each tagged with the block it's in (`modelUser{`).
 * `prisma generate` formats its copy: it re-aligns whitespace, sorts block attributes (`@@unique`
 * before `@@index` before `@@map`) and moves comments between them, and it joins multi-file schemas
 * in no fixed order. So the comparison ignores whitespace and line order, but not which block a
 * line belongs to.
 */
function lines(schema: string): string[] {
  let block = '';
  const out: string[] = [];
  for (const raw of schema.split('\n')) {
    const line = raw.replace(/\s+/g, '');
    if (!line) continue;
    if (!block && /^\w+\{$/.test(line)) block = line;
    out.push(`${block}\0${line}`);
    if (block && line === '}') block = '';
  }
  return out;
}

/** True if both lists hold the same lines, in any order. */
function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((line, i) => line === y[i]);
}

function readGenerated(
  ctx: Context,
  isNew: boolean,
  gen: { file: string; fields: Record<string, string> },
): Generated {
  const { fs } = ctx;
  const output = gen.fields.output;
  if (isNew) {
    if (!output) return { skip: 'prisma-client generator has no output' };
    const dir = resolve(blockDir(gen), output);
    if (!fs.isDir(dir)) return { never: true };
    const file = CLASS_FILES.map((f) => join(dir, f)).find((f) => fs.exists(f));
    const literal = file && /"inlineSchema":\s*("(?:[^"\\]|\\.)*")/.exec(fs.read(file) ?? '')?.[1];
    if (!literal) return { skip: 'unrecognized prisma-client output' };
    return { schema: JSON.parse(literal) as string };
  }
  let dir: string;
  if (output) dir = resolve(blockDir(gen), output);
  else {
    try {
      const req = createRequire(join(ctx.pkgDir, 'package.json'));
      const pkgJson = fs.realpath(req.resolve('@prisma/client/package.json'));
      if (!pkgJson) throw new Error('unresolvable');
      dir = join(dirname(pkgJson), '../../.prisma/client');
    } catch {
      return { skip: '@prisma/client is not installed' };
    }
  }
  const schema = fs.read(join(dir, 'schema.prisma'));
  return schema === undefined ? { never: true } : { schema };
}
