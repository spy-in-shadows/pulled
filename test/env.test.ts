import { describe, expect, it } from 'vitest';
import { envCheck } from '../src/checks/env';
import { ctx, fixture, write } from './helpers';

const pkg = { name: 'app' };
const example =
  'DATABASE_URL=postgres://localhost/app\nJWT_SECRET=\nREDIS_URL=\nSENTRY_DSN= # optional\n';

describe('env check', () => {
  it('is silent when every required key is in .env', () => {
    const dir = fixture({
      'package.json': pkg,
      '.env.example': example,
      '.env': 'DATABASE_URL=postgres://real\nJWT_SECRET=s3cret\nREDIS_URL=redis://x\n',
    });
    expect(envCheck(ctx(dir))).toEqual({ issues: [] });
  });

  it('counts .env.local, process.env and empty values as present', () => {
    const dir = fixture({
      'package.json': pkg,
      '.env.example': example,
      '.env': 'DATABASE_URL=\n',
      '.env.local': 'JWT_SECRET=x',
    });
    expect(envCheck(ctx(dir, { env: { REDIS_URL: '' } })).issues).toEqual([]);
  });

  it('reports missing keys by name only, never values', () => {
    const dir = fixture({
      'package.json': pkg,
      '.env.example': example,
      '.env': 'DATABASE_URL=postgres://user:hunter2@db/app\n',
    });
    const result = envCheck(ctx(dir));
    expect(result.issues).toEqual([
      {
        id: 'env',
        title: 'Missing in .env: JWT_SECRET, REDIS_URL',
        details: [],
        fix: 'add them to .env (see .env.example)',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('postgres://localhost');
  });

  it('reports a missing .env file', () => {
    const dir = fixture({ 'package.json': pkg, '.env.example': example });
    expect(envCheck(ctx(dir)).issues).toEqual([
      {
        id: 'env',
        title: '.env file is missing',
        details: [],
        fix: 'cp .env.example .env, then fill it in',
      },
    ]);
  });

  it('does not report a missing .env when the environment already has every key (CI)', () => {
    const dir = fixture({ 'package.json': pkg, '.env.example': example });
    const env = { DATABASE_URL: 'x', JWT_SECRET: 'x', REDIS_URL: 'x' };
    expect(envCheck(ctx(dir, { env })).issues).toEqual([]);
  });

  it('uses .env.sample / .env.template and names them in the fix', () => {
    const dir = fixture({ 'package.json': pkg, '.env.template': 'A=1', '.env': '' });
    expect(envCheck(ctx(dir)).issues[0]?.fix).toBe('add them to .env (see .env.template)');
  });

  it('uses the configured example file', () => {
    const dir = fixture({
      'package.json': { pulled: { envExample: 'config/env.example' } },
      'config/env.example': 'CUSTOM_KEY=',
      '.env.example': 'OTHER=',
      '.env': '',
    });
    expect(envCheck(ctx(dir)).issues[0]?.title).toBe('Missing in .env: CUSTOM_KEY');
  });

  it('skips when there is no example file', () => {
    const dir = fixture({ 'package.json': pkg, '.env': 'A=1' });
    expect(envCheck(ctx(dir))).toEqual({ issues: [], skip: 'no .env.example file' });
  });

  it('skips when the configured example file does not exist', () => {
    const dir = fixture({ 'package.json': { pulled: { envExample: '.env.dist' } } });
    expect(envCheck(ctx(dir)).skip).toBe('no .env.dist file');
  });

  it('is silent again after the user adds the keys', () => {
    const dir = fixture({ 'package.json': pkg, '.env.example': example, '.env': 'DATABASE_URL=x' });
    expect(envCheck(ctx(dir)).issues).toHaveLength(1);
    write(dir, { '.env': 'DATABASE_URL=x\nJWT_SECRET=\nREDIS_URL=\n' });
    expect(envCheck(ctx(dir)).issues).toHaveLength(0);
  });

  it('is silent again after the user runs the cp fix', () => {
    const dir = fixture({ 'package.json': pkg, '.env.example': example });
    expect(envCheck(ctx(dir)).issues).toHaveLength(1);
    write(dir, { '.env': example });
    expect(envCheck(ctx(dir)).issues).toHaveLength(0);
  });
});
