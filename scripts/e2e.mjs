// End-to-end: npm pack → install the tarball into a temp project → run all three activation modes
// (import/require, node --import, CLI) plus the api, out of sync and then in sync.
// Usage: npm run e2e
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulled-e2e-'));
const app = join(tmp, 'app');
const HEADER = '⚠ pulled: your local setup is out of sync with the code';
const ISSUE = 'Missing in .env: API_KEY';
let failures = 0;

const env = { ...process.env };
for (const key of ['CI', 'NODE_ENV', 'PULLED', 'PULLED_DEBUG', 'NO_COLOR']) delete env[key];

function run(cmd, args, extraEnv = {}) {
  const bin = cmd === 'node' ? process.execPath : cmd;
  const r = spawnSync(bin, args, { cwd: app, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  // npm's own warnings (e.g. under npx) aren't pulled's output.
  const stderr = r.stderr.replace(/^npm warn .*\n/gm, '');
  return { code: r.status, stdout: r.stdout, stderr };
}

function expect(name, ok, result) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures++;
    console.log(
      `       exit ${result.code}\n       stdout: ${result.stdout}\n       stderr: ${result.stderr}`,
    );
  }
}

const count = (s, sub) => s.split(sub).length - 1;
const warnsOnce = (r) => count(r.stderr, HEADER) === 1 && r.stderr.includes(ISSUE);
const ranApp = (r) => r.code === 0 && r.stdout.includes('app ran');

const modes = {
  'import (ESM)': ['node', ['esm.mjs']],
  'require (CJS)': ['node', ['cjs.cjs']],
  'node --import pulled': ['node', ['--import', 'pulled', 'plain.mjs']],
};

try {
  console.log('packing and installing the tarball…');
  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'ignore' });
  const packed = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );
  const [{ filename }] = JSON.parse(packed);
  const files = {
    'package.json': JSON.stringify({ name: 'e2e-app', private: true }),
    '.env.example': 'API_KEY=\nDEBUG= # optional\n',
    '.env': 'OTHER=1\n',
    'esm.mjs': "import 'pulled';\nconsole.log('app ran');\n",
    'cjs.cjs': "require('pulled');\nconsole.log('app ran');\n",
    'plain.mjs': "console.log('app ran');\n",
    'api.mjs': "import { check } from 'pulled/api';\nconsole.log(JSON.stringify(await check()));\n",
  };
  execFileSync('mkdir', [app]);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(app, name), content);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(tmp, filename)], {
    cwd: app,
    stdio: 'ignore',
  });

  console.log('out of sync:');
  for (const [name, [cmd, args]] of Object.entries(modes)) {
    const r = run(cmd, args);
    expect(`${name} warns once and the app still runs`, ranApp(r) && warnsOnce(r), r);
  }
  let r = run('node', ['--import', 'pulled', 'cjs.cjs']);
  expect('ESM + CJS in one process warn only once', ranApp(r) && warnsOnce(r), r);
  r = run('npx', ['pulled']);
  expect('CLI exits 1 with the report', r.code === 1 && warnsOnce(r), r);
  r = run('npx', ['pulled', '--json']);
  const json = JSON.parse(r.stdout || 'null');
  expect(
    'CLI --json prints only the Report',
    r.code === 1 && r.stderr === '' && json?.ok === false && json.issues[0]?.title === ISSUE,
    r,
  );
  r = run('npx', ['pulled'], { CI: 'true', NODE_ENV: 'production' });
  expect('CLI ignores CI and NODE_ENV', r.code === 1 && warnsOnce(r), r);
  r = run('node', ['api.mjs']);
  expect('pulled/api check() reports the issue', JSON.parse(r.stdout).ok === false, r);
  for (const skipEnv of [{ CI: 'true' }, { NODE_ENV: 'production' }, { PULLED: '0' }]) {
    r = run('node', ['esm.mjs'], skipEnv);
    expect(
      `import mode is silent with ${JSON.stringify(skipEnv)}`,
      ranApp(r) && r.stderr === '',
      r,
    );
  }

  const pkgPath = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, pulled: { strict: true } }));
  r = run('node', ['esm.mjs']);
  expect(
    'strict mode exits 1 before the app runs',
    r.code === 1 && !r.stdout.includes('app ran'),
    r,
  );
  writeFileSync(pkgPath, JSON.stringify(pkg));

  console.log('after the user fixes .env:');
  writeFileSync(join(app, '.env'), 'OTHER=1\nAPI_KEY=secret\n');
  for (const [name, [cmd, args]] of Object.entries(modes)) {
    r = run(cmd, args);
    expect(`${name} is silent`, ranApp(r) && r.stderr === '', r);
  }
  r = run('npx', ['pulled']);
  expect('CLI is silent and exits 0', r.code === 0 && r.stdout === '' && r.stderr === '', r);
  r = run('node', ['api.mjs']);
  expect('pulled/api check() is ok', JSON.parse(r.stdout).ok === true, r);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e passed' : `e2e failed: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
