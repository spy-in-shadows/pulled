import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../src/util/dotenv';

const keys = (src: string) => parseDotenv(src).map((e) => e.key);

describe('parseDotenv', () => {
  it('parses plain, exported, empty and spaced assignments', () => {
    const src = 'A=1\nexport B=2\nC=\n  D = four \n';
    expect(parseDotenv(src)).toEqual([
      { key: 'A', value: '1', optional: false },
      { key: 'B', value: '2', optional: false },
      { key: 'C', value: '', optional: false },
      { key: 'D', value: 'four', optional: false },
    ]);
  });

  it('ignores comments, blank lines and junk', () => {
    expect(keys('# A=1\n\n   \nnot a line\n=nokey\n1BAD=x\nOK=1')).toEqual(['OK']);
  });

  it('handles inline comments and # inside values', () => {
    expect(parseDotenv('A=abc # note\nB=a#b\nC=#only-comment')).toEqual([
      { key: 'A', value: 'abc', optional: false },
      { key: 'B', value: 'a#b', optional: false },
      { key: 'C', value: '', optional: false },
    ]);
  });

  it('handles quoted values, including # and escaped quotes', () => {
    const src = `A="x # y"\nB='single # q'\nC="say \\"hi\\""\nD=\`tick\``;
    expect(parseDotenv(src).map((e) => e.value)).toEqual([
      'x # y',
      'single # q',
      'say "hi"',
      'tick',
    ]);
  });

  it('handles multiline double-quoted values without leaking keys', () => {
    const src = 'KEY="-----BEGIN-----\nFAKE=not-a-key\n-----END-----"\nNEXT=1';
    expect(keys(src)).toEqual(['KEY', 'NEXT']);
    expect(parseDotenv(src)[0]?.value).toBe('-----BEGIN-----\nFAKE=not-a-key\n-----END-----');
  });

  it('treats an unterminated quote as a single-line value', () => {
    expect(keys('A="oops\nB=2')).toEqual(['A', 'B']);
  });

  it('handles CRLF', () => {
    expect(keys('A=1\r\nB="x\r\ny"\r\nC=3\r\n')).toEqual(['A', 'B', 'C']);
  });

  it('detects trailing # optional comments', () => {
    const src =
      'A=1 # optional\nB="x" #optional, used for tracing\nC= # Optional\nD=1 # not optional\nE=optional';
    expect(parseDotenv(src).map((e) => [e.key, e.optional])).toEqual([
      ['A', true],
      ['B', true],
      ['C', true],
      ['D', false],
      ['E', false],
    ]);
  });

  it('never expands anything', () => {
    const homeRef = ['$', '{HOME}'].join('');
    expect(parseDotenv(`A=${homeRef}\nB=$(whoami)`).map((e) => e.value)).toEqual([
      homeRef,
      '$(whoami)',
    ]);
  });
});
