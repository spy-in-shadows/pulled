// End-to-end: npm pack → install the tarball into a temp project → run all three activation modes
// (import/require, node --import, CLI) plus the api, out of sync and then in sync.
// Usage: npm run e2e
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// npm and npx are .cmd shims on Windows, which only run through a shell. The args here are
// fixed strings and temp paths, quoted for cmd.exe.
const win = process.platform === 'win32';
const shellArgs = (cmd, args) =>
  win
    ? [[cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), [], { shell: true }]
    : [cmd, args, {}];

function sh(cmd, args, opts) {
  const [file, argv, extra] = shellArgs(cmd, args);
  execFileSync(file, argv, { ...opts, ...extra });
}

function run(cmd, args, extraEnv = {}) {
  const [file, argv, extra] = cmd === 'node' ? [process.execPath, args, {}] : shellArgs(cmd, args);
  const r = spawnSync(file, argv, {
    ...extra,
    cwd: app,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
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
  sh('npm', ['run', 'build'], { cwd: repo, stdio: 'ignore' });
  const pack = (cwd) => {
    const [file, argv, extra] = shellArgs('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      tmp,
    ]);
    return JSON.parse(execFileSync(file, argv, { ...extra, cwd, encoding: 'utf8' }))[0].filename;
  };
  const filename = pack(repo);
  // A tiny dependency, so `--fix` has something real to reinstall (offline).
  const dep = join(tmp, 'dep');
  mkdirSync(dep);
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
  const depTarball = pack(dep);
  const files = {
    'package.json': JSON.stringify({ name: 'e2e-app', private: true }),
    '.env.example': 'API_KEY=\nDEBUG= # optional\n',
    '.env': 'OTHER=1\n',
    'esm.mjs': "import 'pulled';\nconsole.log('app ran');\n",
    'cjs.cjs': "require('pulled');\nconsole.log('app ran');\n",
    'plain.mjs': "console.log('app ran');\n",
    'api.mjs': "import { check } from 'pulled/api';\nconsole.log(JSON.stringify(await check()));\n",
  };
  mkdirSync(app);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(app, name), content);
  sh('npm', ['install', '--no-audit', '--no-fund', join(tmp, filename), join(tmp, depTarball)], {
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
  for (const args of [['pulled'], ['pulled', '--json']]) {
    r = run('npx', args, { PULLED: 'off' });
    expect(
      `CLI ${args.slice(1).join(' ')} exits 0 with no output with PULLED=off`.replace('  ', ' '),
      r.code === 0 && r.stdout === '' && r.stderr === '',
      r,
    );
  }
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

  console.log('after a pull adds a dependency that is not installed yet:');
  rmSync(join(app, 'node_modules', 'dep'), { recursive: true, force: true });
  const hidden = join(app, 'node_modules', '.package-lock.json');
  const hiddenLock = JSON.parse(readFileSync(hidden, 'utf8'));
  delete hiddenLock.packages['node_modules/dep'];
  writeFileSync(hidden, JSON.stringify(hiddenLock, null, 2));
  r = run('npx', ['pulled']);
  expect('CLI reports it', r.code === 1 && r.stderr.includes('dep (not installed)'), r);
  r = run('npx', ['pulled', '--fix']);
  expect('CLI --fix runs npm install and exits 0', r.code === 0, r);
  r = run('npx', ['pulled']);
  expect('CLI is silent again', r.code === 0 && r.stdout === '' && r.stderr === '', r);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e passed' : `e2e failed: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
