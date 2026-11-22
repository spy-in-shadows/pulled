import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { CheckResult, Context } from '../types';
import { execCmd } from '../util/context';
import { parseDotenv } from '../util/dotenv';
import { type Block, loadPrisma, type PrismaProject, single, usesPrisma } from '../util/prisma';

const TIMEOUT_MS = 1500;
const SQL =
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL';

/** Returns the names of applied migrations. `pgPath` is the resolved path of the project's `pg`. */
export type QueryFn = (url: string, pgPath: string) => Promise<string[]>;

const skip = (reason: string): CheckResult => ({ issues: [], skip: reason });

/** `migrations`: migration folders on disk that the database hasn't applied. */
export async function migrationsCheck(
  ctx: Context,
  query: QueryFn = pgQuery,
): Promise<CheckResult> {
  if (!usesPrisma(ctx)) return skip('prisma is not a dependency');
  const project = loadPrisma(ctx);
  if (!project) return skip('no Prisma schema found');
  const ds = project.datasource;
  const dir = migrationsDir(project, ds);
  if (!ctx.fs.isDir(dir)) return skip('no migrations folder');
  const provider = ds?.fields.provider;
  if (provider !== 'postgresql' && provider !== 'postgres') {
    return skip(`datasource provider is ${provider ?? 'unknown'}; only postgresql is supported`);
  }

  const source = dbSource(project, ds);
  if (!source) return skip('unclear which database the app uses');
  const dotenv = () => parseDotenv(ctx.fs.read(join(ctx.pkgDir, '.env')) ?? '');
  const url =
    'url' in source
      ? source.url
      : ctx.env[source.env] || dotenv().find((e) => e.key === source.env)?.value;
  if (!url) return skip(`${(source as { env: string }).env} is not set`);

  let pgPath: string;
  try {
    pgPath = createRequire(join(ctx.pkgDir, 'package.json')).resolve('pg');
  } catch {
    return skip('install pg to enable');
  }

  let applied: Set<string>;
  try {
    applied = new Set(await query(url, pgPath));
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).replaceAll(url, '<url>');
    ctx.debug(`migrations: query to ${host(url)} failed: ${msg}`);
    return skip('could not query the database');
  }

  const pending = ctx.fs
    .list(dir)
    .filter((n) => !applied.has(n) && ctx.fs.exists(join(dir, n, 'migration.sql')))
    .sort();
  if (pending.length === 0) return { issues: [] };
  const names =
    pending.slice(0, 3).join(', ') + (pending.length > 3 ? `, +${pending.length - 3} more` : '');
  const count = pending.length === 1 ? '1 migration' : `${pending.length} migrations`;
  return {
    issues: [
      {
        id: 'migrations',
        title: `${count} not applied: ${names}`,
        details: [],
        fix: `${execCmd(ctx.pm, 'prisma')} migrate dev`,
      },
    ],
  };
}

function migrationsDir(project: PrismaProject, ds: Block | undefined): string {
  const { config } = project;
  const fromConfig =
    config && single(config.text, /\bmigrations\s*:\s*\{[^}]*?\bpath\s*:\s*(["'])([^"'\n]+)\1/g);
  if (config && fromConfig) return resolve(config.dir, fromConfig);
  return join(dirname(ds?.file ?? (project.files[0] as string)), 'migrations');
}

const isPgUrl = (s: string) => /^postgres(ql)?:\/\//.test(s);

/**
 * A `url` key in prisma.config.*, in any form: `url:`, `'url':`, shorthand `{ url }`, or a method
 * `url() {…}`. Other keys (shadowDatabaseUrl, directUrl, …) and `x.url` never match.
 */
const CONFIG_URL_KEY = /(?<![\w$.])(["']?)url\1\s*(?=[:,}(])/g;

/**
 * A `url` value pulled can read: `: env("X")`, `: env('X')`, `: process.env.X` or `: "literal"`,
 * followed by `,`, `}` or the end of the line. Anything else is unclear.
 */
const CONFIG_URL_VALUE =
  /^:\s*(?:env\(\s*(["'])(\w+)\1\s*\)|process\.env\.(\w+)|(["'])([^"'\n]*)\4)(?=\s*[,}]|[ \t]*(?:\r?\n|$))/;

/**
 * Which database the app uses: schema `url = env("X")` → a hard-coded schema url → the single
 * `url` key in prisma.config.* → DATABASE_URL only if neither has a url. Undefined when unclear.
 */
function dbSource(
  project: PrismaProject,
  ds: Block | undefined,
): { env: string } | { url: string } | undefined {
  const schemaUrl = ds?.fields.url;
  if (schemaUrl !== undefined) {
    const name = /^env\(\s*"(\w+)"\s*\)$/.exec(schemaUrl)?.[1];
    if (name) return { env: name };
    return isPgUrl(schemaUrl) ? { url: schemaUrl } : undefined;
  }
  const text = project.config?.text ?? '';
  const keys = [...text.matchAll(CONFIG_URL_KEY)];
  if (keys.length === 0) return { env: 'DATABASE_URL' };
  if (keys.length > 1) return undefined;
  const [key] = keys as [RegExpExecArray];
  const m = CONFIG_URL_VALUE.exec(text.slice(key.index + key[0].length));
  const name = m?.[2] ?? m?.[3];
  if (name) return { env: name };
  const literal = m?.[5];
  return literal !== undefined && isPgUrl(literal) ? { url: literal } : undefined;
}

/** host:port of a connection string, for debug output (never the full URL: it has the password). */
function host(url: string): string {
  try {
    return new URL(url).host || 'the database';
  } catch {
    return 'the database';
  }
}

interface PgClient {
  connection?: { stream?: { unref?: () => void; destroy?: () => void } };
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: { migration_name: string }[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): void;
}

/**
 * Queries with the project's own `pg`. The timer and the connected socket are unref'd so the host
 * can exit. A TCP connect that is still in flight holds the event loop no matter what (libuv), so
 * on timeout or error the socket is destroyed: the worst case is the host exiting 1.5 s late.
 */
const pgQuery: QueryFn = async (url, pgPath) => {
  const pg = createRequire(pgPath)(pgPath) as { Client: new (c: object) => PgClient };
  const client = new pg.Client({ connectionString: url });
  // A dropped connection is emitted as 'error'; unhandled, it would crash the host.
  client.on('error', () => {});
  client.connection?.stream?.unref?.();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    timer.unref();
  });
  const run = (async () => {
    await client.connect();
    const { rows } = await client.query(SQL);
    return rows.map((r) => r.migration_name);
  })();
  run.catch(() => {});
  try {
    const names = await Promise.race([run, timeout]);
    client.end().catch(() => {});
    return names;
  } catch (err) {
    client.connection?.stream?.destroy?.();
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
