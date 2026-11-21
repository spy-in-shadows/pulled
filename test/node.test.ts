import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeCheck } from '../src/checks/node';
import { ctx, fixture, write } from './helpers';

const pkg = { name: 'app' };

describe('node check', () => {
  it.each(['22', 'v22', '22.11.0', 'v22.1', '22\n'])('is silent when %j matches the major', (v) => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': v });
    expect(nodeCheck(ctx(dir, { nodeVersion: '22.3.0' }))).toEqual({ issues: [] });
  });

  it('reports a major mismatch from .nvmrc with `nvm use`', () => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': '22' });
    expect(nodeCheck(ctx(dir, { nodeVersion: '20.11.1' })).issues).toEqual([
      {
        id: 'node',
        title: "Project expects Node 22, you're on 20.11.1",
        details: [],
        fix: 'nvm use',
      },
    ]);
  });

  it('reports a mismatch from .node-version with a plain instruction', () => {
    const dir = fixture({ 'package.json': pkg, '.node-version': 'v22.11.0' });
    const [issue] = nodeCheck(ctx(dir, { nodeVersion: '20.11.1' })).issues;
    expect(issue?.fix).toBe('switch to Node 22');
  });

  it('prefers .nvmrc over .node-version', () => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': '20', '.node-version': '22' });
    expect(nodeCheck(ctx(dir, { nodeVersion: '20.1.0' })).issues).toEqual([]);
  });

  it('finds .nvmrc at the workspace root', () => {
    const dir = fixture({
      'package.json': { workspaces: ['packages/*'] },
      'package-lock.json': '{}',
      '.nvmrc': '22',
      'packages/a/package.json': pkg,
    });
    const result = nodeCheck(ctx(join(dir, 'packages/a'), { nodeVersion: '20.0.0' }));
    expect(result.issues[0]?.title).toBe("Project expects Node 22, you're on 20.0.0");
  });

  it.each(['lts/*', 'lts/jod', 'node', 'stable'])('skips the alias %j', (alias) => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': alias });
    expect(nodeCheck(ctx(dir))).toEqual({
      issues: [],
      skip: `.nvmrc contains "${alias}", not a version number`,
    });
  });

  it('skips when there is no version file', () => {
    const dir = fixture({ 'package.json': pkg });
    expect(nodeCheck(ctx(dir)).skip).toBe('no .nvmrc or .node-version');
  });

  it('is silent again after the user switches Node', () => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': '22' });
    expect(nodeCheck(ctx(dir, { nodeVersion: '20.11.1' })).issues).toHaveLength(1);
    expect(nodeCheck(ctx(dir, { nodeVersion: '22.11.0' })).issues).toHaveLength(0);
  });

  it('is silent again after the project updates .nvmrc', () => {
    const dir = fixture({ 'package.json': pkg, '.nvmrc': '22' });
    write(dir, { '.nvmrc': '20' });
    expect(nodeCheck(ctx(dir, { nodeVersion: '20.11.1' })).issues).toHaveLength(0);
  });
});
