// Benchmark: all synchronous checks on a project with ~1000 lockfile entries must take < 25 ms.
// Usage: npm run bench (builds first). Runs import mode in fresh processes, like a real app start,
// and reads the "sync checks: X ms" timing that PULLED_DEBUG prints.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRIES = 1000;
const RUNS = 30;
const LIMIT_MS = 25;
const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.js');

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

/** An npm + Prisma project with ENTRIES installed packages, .nvmrc, .env and .env.example. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'pulled-bench-'));
  const direct = {};
  const packages = {};
  const files = {};
  for (let i = 0; i < ENTRIES; i++) {
    const name = i % 10 === 0 ? `@scope/pkg-${i}` : `pkg-${i}`;
    const version = `1.${i % 7}.${i % 13}`;
    if (i < 40) direct[name] = `^${version}`;
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
      integrity: `sha512-${'x'.repeat(86)}==`,
      ...(i >= 40 && i % 3 === 0 ? { dev: true } : {}),
    };
    files[`node_modules/${name}/package.json`] = { name, version };
  }
  direct['@prisma/client'] = '^6.19.3';
  packages['node_modules/@prisma/client'] = { version: '6.19.3' };
  files['node_modules/@prisma/client/package.json'] = { name: '@prisma/client', version: '6.19.3' };
  const pkg = { name: 'bench-app', dependencies: direct, devDependencies: { prisma: '^6.19.3' } };
  packages['node_modules/prisma'] = { version: '6.19.3', dev: true };
  files['node_modules/prisma/package.json'] = { name: 'prisma', version: '6.19.3' };

  const models = Array.from(
    { length: 40 },
    (_, i) =>
      `model M${i} {\n  id Int @id\n  name String\n  createdAt DateTime @default(now())\n}\n`,
  ).join('\n');
  const schema = `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\n${models}`;
  const keys = Array.from({ length: 30 }, (_, i) => `KEY_${i}`);

  write(root, {
    ...files,
    'package.json': pkg,
    'package-lock.json': {
      name: 'bench-app',
      lockfileVersion: 3,
      requires: true,
      packages: { '': pkg, ...packages },
    },
    'node_modules/.package-lock.json': { name: 'bench-app', lockfileVersion: 3, packages },
    '.nvmrc': `${process.versions.node.split('.')[0]}\n`,
    '.env.example': keys.map((k) => `${k}=`).join('\n'),
    '.env': keys.map((k) => `${k}=value`).join('\n'),
    'prisma/schema.prisma': schema,
    'node_modules/.prisma/client/schema.prisma': schema,
  });
  return root;
}

function measure(cwd) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const r = spawnSync(process.execPath, ['--import', entry, '-e', ''], {
      cwd,
      env: { ...process.env, PULLED_DEBUG: '1', CI: '', NODE_ENV: '', PULLED: '' },
      encoding: 'utf8',
    });
    const ms = /sync checks: ([\d.]+) ms/.exec(r.stderr)?.[1];
    if (!ms) throw new Error(`no timing in output:\n${r.stderr}`);
    if (/out of sync/.test(r.stderr)) throw new Error(`fixture is not in sync:\n${r.stderr}`);
    times.push(Number(ms));
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(RUNS / 2)],
    p90: times[Math.floor(RUNS * 0.9)],
    max: times.at(-1),
  };
}

const root = project();
try {
  const scenarios = {
    'in sync (hidden lockfile matches)': () => {},
    'worst case (no hidden lockfile: reads every package.json)': () =>
      rmSync(join(root, 'node_modules/.package-lock.json')),
  };
  let failed = false;
  console.log(`pulled sync checks, ${ENTRIES} lockfile entries, ${RUNS} fresh processes each`);
  for (const [name, setup] of Object.entries(scenarios)) {
    setup();
    const { median, p90, max } = measure(root);
    const ok = p90 < LIMIT_MS;
    failed ||= !ok;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${name}: median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
  }
  console.log(`  limit: p90 < ${LIMIT_MS} ms`);
  process.exitCode = failed ? 1 : 0;
} finally {
  rmSync(root, { recursive: true, force: true });
}
