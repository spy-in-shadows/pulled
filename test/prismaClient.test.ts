import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prismaClientCheck } from '../src/checks/prismaClient';
import { ctx, fixture, remove, write } from './helpers';

const pkg = {
  name: 'app',
  dependencies: { '@prisma/client': '^6' },
  devDependencies: { prisma: '^6' },
};
const clientPkg = { 'node_modules/@prisma/client/package.json': { name: '@prisma/client' } };

const schema6 = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL") // see https://pris.ly
}

model User {
  id Int @id
  email String @unique
}
`;
/** What `prisma generate` writes: the schema run through `prisma format`. */
const formatted6 = schema6
  .replace('url = env', 'url      = env')
  .replace('id Int @id', 'id    Int    @id')
  .replace('email String', 'email String');

const issue = (title: string, fix = 'npx prisma generate') => ({
  id: 'prisma-client',
  title,
  details: [],
  fix,
});
const NEVER = 'Prisma client was never generated';
const STALE = 'Prisma schema changed since the client was generated';

describe('prisma-client check: prisma-client-js (Prisma 6)', () => {
  const project = (generated?: string) =>
    fixture({
      'package.json': pkg,
      'prisma/schema.prisma': schema6,
      ...clientPkg,
      ...(generated === undefined
        ? {}
        : { 'node_modules/.prisma/client/schema.prisma': generated }),
    });

  it('is silent when the generated copy matches (ignoring formatting)', () => {
    expect(prismaClientCheck(ctx(project(formatted6)))).toEqual({ issues: [] });
  });

  it('reports a client that was never generated', () => {
    expect(prismaClientCheck(ctx(project())).issues).toEqual([issue(NEVER)]);
  });

  it('reports a field being added', () => {
    const dir = project(formatted6);
    write(dir, {
      'prisma/schema.prisma': schema6.replace(
        'email String @unique',
        'email String @unique\n  name String?',
      ),
    });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(STALE)]);
  });

  it('is silent after whitespace-only and line-ending edits', () => {
    const dir = project(formatted6);
    write(dir, {
      'prisma/schema.prisma': `\n\n${schema6.replace(/ /g, '\t  ').replace(/\n/g, '\r\n\n')}`,
    });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
  });

  it('is silent again after the user runs prisma generate', () => {
    const dir = project(formatted6);
    const changed = schema6.replace('}\n\nmodel', '}\n\nmodel Post {\n  id Int @id\n}\n\nmodel');
    write(dir, { 'prisma/schema.prisma': changed });
    expect(prismaClientCheck(ctx(dir)).issues).toHaveLength(1);
    write(dir, { 'node_modules/.prisma/client/schema.prisma': changed });
    expect(prismaClientCheck(ctx(dir)).issues).toHaveLength(0);
  });

  it('finds the client next to the real @prisma/client (pnpm layout)', () => {
    const store = 'node_modules/.pnpm/@prisma+client@6.19.3/node_modules';
    const dir = fixture({
      'package.json': pkg,
      'prisma/schema.prisma': schema6,
      [`${store}/@prisma/client/package.json`]: { name: '@prisma/client' },
      [`${store}/.prisma/client/schema.prisma`]: formatted6,
    });
    mkdirSync(join(dir, 'node_modules/@prisma'));
    symlinkSync(
      join(dir, store, '@prisma/client'),
      join(dir, 'node_modules/@prisma/client'),
      'dir',
    );
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
    write(dir, { [`${store}/.prisma/client/schema.prisma`]: 'model Old { id Int @id }' });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(STALE)]);
  });

  it('uses a custom output path relative to the schema file', () => {
    const custom = schema6.replace(
      '"prisma-client-js"',
      '"prisma-client-js"\n  output = "../generated/client"',
    );
    const dir = fixture({ 'package.json': pkg, 'prisma/schema.prisma': custom });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(NEVER)]);
    write(dir, { 'generated/client/schema.prisma': custom });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
  });

  it('skips when @prisma/client is not installed', () => {
    const dir = fixture({ 'package.json': pkg, 'prisma/schema.prisma': schema6 });
    expect(prismaClientCheck(ctx(dir)).skip).toBe('@prisma/client is not installed');
  });

  it('uses the package manager in the fix command', () => {
    const dir = project();
    write(dir, { 'pnpm-lock.yaml': '' });
    expect(prismaClientCheck(ctx(dir)).issues[0]?.fix).toBe('pnpm exec prisma generate');
  });
});

describe('prisma-client check: multi-file schemas', () => {
  const files = {
    'prisma/schema/main.prisma': schema6.slice(0, schema6.indexOf('model')),
    'prisma/schema/user.prisma': 'model User {\n  id Int @id\n}\n',
    'prisma/schema/sub/post.prisma': 'model Post {\n  id Int @id\n}\n',
  };
  // Prisma concatenates the files in no fixed order.
  const generated = [
    files['prisma/schema/sub/post.prisma'],
    files['prisma/schema/main.prisma'],
    files['prisma/schema/user.prisma'],
  ].join('\n');
  const project = () =>
    fixture({
      'package.json': { ...pkg, prisma: { schema: 'prisma/schema' } },
      ...files,
      ...clientPkg,
      'node_modules/.prisma/client/schema.prisma': generated,
    });

  it('is silent when every file is in the generated schema, in any order', () => {
    expect(prismaClientCheck(ctx(project())).issues).toEqual([]);
  });

  it('is silent when files are reordered or renamed', () => {
    const dir = project();
    remove(dir, 'prisma/schema/user.prisma');
    write(dir, { 'prisma/schema/a-user.prisma': files['prisma/schema/user.prisma'] });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
  });

  it('reports a field added in one file', () => {
    const dir = project();
    write(dir, { 'prisma/schema/user.prisma': 'model User {\n  id Int @id\n  name String\n}\n' });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(STALE)]);
  });

  it('reports a new file', () => {
    const dir = project();
    write(dir, { 'prisma/schema/tag.prisma': 'model Tag {\n  id Int @id\n}\n' });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(STALE)]);
  });

  it('falls back to a plain prisma/ folder of .prisma files', () => {
    const dir = fixture({
      'package.json': pkg,
      'prisma/main.prisma': files['prisma/schema/main.prisma'],
      'prisma/models/user.prisma': files['prisma/schema/user.prisma'],
      'prisma/migrations/0_init/migration.sql': '',
      ...clientPkg,
      'node_modules/.prisma/client/schema.prisma': `${files['prisma/schema/user.prisma']}${files['prisma/schema/main.prisma']}`,
    });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
  });
});

const schema7 = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id Int @id
}
`;
const classFile = (s: string) =>
  `const config = {\n  "clientVersion": "7.10.1",\n  "inlineSchema": ${JSON.stringify(s)},\n  "runtimeDataModel": {}\n}\n`;

describe('prisma-client check: prisma-client (Prisma 7)', () => {
  const project = (generated?: string, ext = 'ts') =>
    fixture({
      'package.json': pkg,
      'prisma.config.ts':
        'import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: "db/schema.prisma" });\n',
      'db/schema.prisma': schema7,
      ...(generated === undefined
        ? {}
        : { [`src/generated/prisma/internal/class.${ext}`]: classFile(generated) }),
    });

  it('is silent when inlineSchema matches (schema path from prisma.config.ts)', () => {
    expect(prismaClientCheck(ctx(project(schema7)))).toEqual({ issues: [] });
  });

  it('reads .mts output', () => {
    expect(prismaClientCheck(ctx(project(schema7, 'mts'))).issues).toEqual([]);
  });

  it('reports a client that was never generated', () => {
    expect(prismaClientCheck(ctx(project())).issues).toEqual([issue(NEVER)]);
  });

  it('reports a changed schema and is silent after generate', () => {
    const dir = project(schema7);
    const changed = schema7.replace('id Int @id', 'id Int @id\n  name String');
    write(dir, { 'db/schema.prisma': changed });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([issue(STALE)]);
    write(dir, { 'src/generated/prisma/internal/class.ts': classFile(changed) });
    expect(prismaClientCheck(ctx(dir)).issues).toEqual([]);
  });

  it('skips output it does not recognize', () => {
    const dir = project();
    write(dir, { 'src/generated/prisma/client.ts': '' });
    expect(prismaClientCheck(ctx(dir)).skip).toBe('unrecognized prisma-client output');
  });
});

describe('prisma-client check: skips', () => {
  it('skips when prisma is not a dependency', () => {
    const dir = fixture({ 'package.json': { name: 'app' }, 'prisma/schema.prisma': schema6 });
    expect(prismaClientCheck(ctx(dir)).skip).toBe('prisma is not a dependency');
  });

  it('skips when there is no schema', () => {
    expect(prismaClientCheck(ctx(fixture({ 'package.json': pkg }))).skip).toBe(
      'no Prisma schema found',
    );
  });

  it('skips when no generator produces a Prisma client', () => {
    const dir = fixture({
      'package.json': pkg,
      'prisma/schema.prisma': 'generator dbml {\n  provider = "prisma-dbml-generator"\n}\n',
    });
    expect(prismaClientCheck(ctx(dir)).skip).toBe('no prisma-client generator');
  });
});
