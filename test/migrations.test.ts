import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { migrationsCheck, type QueryFn } from '../src/checks/migrations';
import { ctx, fixture, remove } from './helpers';

const pkg = {
  name: 'app',
  dependencies: { '@prisma/client': '^6', pg: '^8' },
  devDependencies: { prisma: '^6' },
};
const schema = (provider = 'postgresql', url = 'env("DATABASE_URL")') =>
  `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "${provider}"\n  url      = ${url}\n}\n`;
const migrations = {
  'prisma/migrations/20261119_init/migration.sql': 'CREATE TABLE a();',
  'prisma/migrations/20261120_add_users/migration.sql': 'CREATE TABLE b();',
  'prisma/migrations/20261121_add_index/migration.sql': 'CREATE INDEX c;',
  'prisma/migrations/migration_lock.toml': 'provider = "postgresql"',
};
const fakePg = {
  'node_modules/pg/package.json': { name: 'pg', main: 'index.js' },
  'node_modules/pg/index.js': '',
};
const env = { DATABASE_URL: 'postgresql://localhost/app' };
const applied =
  (...names: string[]): QueryFn =>
  async () =>
    names;

function project(files: Record<string, string | object> = {}) {
  return fixture({
    'package.json': pkg,
    'prisma/schema.prisma': schema(),
    ...migrations,
    ...fakePg,
    ...files,
  });
}

describe('migrations check', () => {
  it('is silent when every migration is applied', async () => {
    const result = await migrationsCheck(
      ctx(project(), { env }),
      applied('20261119_init', '20261120_add_users', '20261121_add_index'),
    );
    expect(result).toEqual({ issues: [] });
  });

  it('reports pending migrations in order', async () => {
    const result = await migrationsCheck(ctx(project(), { env }), applied('20261119_init'));
    expect(result.issues).toEqual([
      {
        id: 'migrations',
        title: '2 migrations not applied: 20261120_add_users, 20261121_add_index',
        details: [],
        fix: 'npx prisma migrate dev',
      },
    ]);
  });

  it('lists at most 3 names', async () => {
    const dir = project({
      'prisma/migrations/20261122_a/migration.sql': '',
      'prisma/migrations/20261123_b/migration.sql': '',
    });
    const [issue] = (await migrationsCheck(ctx(dir, { env }), applied())).issues;
    expect(issue?.title).toBe(
      '5 migrations not applied: 20261119_init, 20261120_add_users, 20261121_add_index, +2 more',
    );
  });

  it('ignores folders without migration.sql', async () => {
    const dir = project({ 'prisma/migrations/20261122_draft/notes.md': '' });
    const result = await migrationsCheck(
      ctx(dir, { env }),
      applied('20261119_init', '20261120_add_users', '20261121_add_index'),
    );
    expect(result.issues).toEqual([]);
  });

  it('is silent again after the user applies the migrations', async () => {
    const c = ctx(project(), { env });
    expect((await migrationsCheck(c, applied('20261119_init'))).issues).toHaveLength(1);
    const all = applied('20261119_init', '20261120_add_users', '20261121_add_index');
    expect((await migrationsCheck(c, all)).issues).toHaveLength(0);
  });

  it('stays silent when the query fails and explains under PULLED_DEBUG', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failing: QueryFn = async () => {
      throw new Error('relation "_prisma_migrations" does not exist');
    };
    const result = await migrationsCheck(
      ctx(project(), { env: { ...env, PULLED_DEBUG: '1' } }),
      failing,
    );
    expect(result).toEqual({ issues: [], skip: 'could not query the database' });
    expect(String(stderr.mock.calls[0]?.[0])).toContain('_prisma_migrations');
    stderr.mockRestore();
  });

  describe('connection string', () => {
    const urlSeenBy = async (dir: string, e: Record<string, string> = {}) => {
      let seen: string | undefined;
      await migrationsCheck(ctx(dir, { env: e }), async (url) => {
        seen = url;
        return [];
      });
      return seen;
    };

    it('prefers process.env over .env and never touches process.env', async () => {
      const dir = project({ '.env': 'DATABASE_URL="postgresql://from-dotenv"' });
      expect(await urlSeenBy(dir, { DATABASE_URL: 'postgresql://from-env' })).toBe(
        'postgresql://from-env',
      );
      expect(await urlSeenBy(dir)).toBe('postgresql://from-dotenv');
      expect(process.env.DATABASE_URL).toBeUndefined();
    });

    it('uses the env() name from the schema datasource', async () => {
      const dir = project({ 'prisma/schema.prisma': schema('postgresql', 'env("PRIMARY_DB")') });
      expect(await urlSeenBy(dir, { DATABASE_URL: 'wrong', PRIMARY_DB: 'right' })).toBe('right');
    });

    it.each([
      ['env("X")', 'datasource: { url: env("APP_DB") }', 'right'],
      ["env('X')", "datasource: { url: env('APP_DB') }", 'right'],
      ['process.env.X', 'datasource: { url: process.env.APP_DB }', 'right'],
      [
        'several names → DATABASE_URL',
        'url: env("APP_DB"), shadowDatabaseUrl: env("SHADOW_DB")',
        'default',
      ],
    ])('reads prisma.config.ts: %s', async (_, body, expected) => {
      const dir = project({
        'prisma/schema.prisma': schema('postgresql', '').replace(/\n {2}url.*\n/, '\n'),
        'prisma.config.ts': `export default defineConfig({ ${body} });`,
      });
      const seen = await urlSeenBy(dir, {
        DATABASE_URL: 'default',
        APP_DB: 'right',
        SHADOW_DB: 'shadow',
      });
      expect(seen).toBe(expected);
    });
  });

  it('finds the migrations folder from prisma.config.ts', async () => {
    const dir = fixture({
      'package.json': pkg,
      'db/schema.prisma': schema(),
      'prisma.config.ts':
        'export default { schema: "db/schema.prisma", migrations: { path: "db/history" } }',
      'db/history/20261120_add_users/migration.sql': '',
      ...fakePg,
    });
    const result = await migrationsCheck(ctx(dir, { env }), applied());
    expect(result.issues[0]?.title).toBe('1 migration not applied: 20261120_add_users');
  });

  describe('skips', () => {
    const skipOf = async (dir: string, e: Record<string, string> = env) =>
      (await migrationsCheck(ctx(dir, { env: e }), applied())).skip;

    it('when prisma is not a dependency', async () => {
      expect(await skipOf(project({ 'package.json': { name: 'app' } }))).toBe(
        'prisma is not a dependency',
      );
    });

    it('when there is no migrations folder', async () => {
      const dir = project();
      remove(dir, 'prisma/migrations');
      expect(await skipOf(dir)).toBe('no migrations folder');
    });

    it('when the provider is not postgresql', async () => {
      const dir = project({ 'prisma/schema.prisma': schema('mysql') });
      expect(await skipOf(dir)).toBe('datasource provider is mysql; only postgresql is supported');
    });

    it('when no connection string is found', async () => {
      expect(await skipOf(project(), {})).toBe('DATABASE_URL is not set');
    });

    it('when pg is not installed', async () => {
      const dir = project();
      remove(dir, 'node_modules/pg');
      expect(await skipOf(dir)).toBe('install pg to enable');
    });
  });
});

/** Real database tests: PULLED_TEST_DATABASE_URL=postgresql://... npm test */
const dbUrl = process.env.PULLED_TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('migrations check against a real database', () => {
  const linkRealPg = (dir: string) => {
    remove(dir, 'node_modules/pg');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(resolve('node_modules/pg'), join(dir, 'node_modules/pg'), 'dir');
  };

  it('reports only migrations that are not finished or were rolled back', async () => {
    const schemaName = `pulled_test_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: dbUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      await admin.query(`CREATE TABLE ${schemaName}._prisma_migrations (
        migration_name text, finished_at timestamptz, rolled_back_at timestamptz)`);
      await admin.query(`INSERT INTO ${schemaName}._prisma_migrations VALUES
        ('20261119_init', now(), NULL), ('20261120_add_users', now(), now()), ('20261121_add_index', NULL, NULL)`);
      const url = new URL(dbUrl as string);
      url.searchParams.set('options', `-c search_path=${schemaName}`);
      const dir = project();
      linkRealPg(dir);
      const result = await migrationsCheck(ctx(dir, { env: { DATABASE_URL: url.toString() } }));
      expect(result.issues[0]?.title).toBe(
        '2 migrations not applied: 20261120_add_users, 20261121_add_index',
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await admin.end();
    }
  });

  it('stays silent when the table is missing', async () => {
    const dir = project();
    linkRealPg(dir);
    const url = new URL(dbUrl as string);
    url.searchParams.set('options', '-c search_path=pulled_no_such_schema');
    const result = await migrationsCheck(ctx(dir, { env: { DATABASE_URL: url.toString() } }));
    expect(result).toEqual({ issues: [], skip: 'could not query the database' });
  });

  it('stays silent when the database is unreachable', async () => {
    const dir = project();
    linkRealPg(dir);
    const result = await migrationsCheck(
      ctx(dir, { env: { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x' } }),
    );
    expect(result.skip).toBe('could not query the database');
  });
});
