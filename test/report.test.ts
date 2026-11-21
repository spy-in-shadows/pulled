import { describe, expect, it } from 'vitest';
import { format, useColor } from '../src/report';
import type { Issue } from '../src/types';

const issues: Issue[] = [
  {
    id: 'deps',
    title: 'Dependencies: 3 packages differ from package-lock.json',
    details: ['express 4.19.2 → 4.21.1, zod (not installed), +1 more'],
    fix: 'npm install',
  },
  {
    id: 'prisma-client',
    title: 'Prisma schema changed since the client was generated',
    details: [],
    fix: 'npx prisma generate',
  },
  {
    id: 'env',
    title: 'Missing in .env: JWT_SECRET, REDIS_URL',
    details: [],
    fix: 'add them to .env (see .env.example)',
  },
];

describe('format', () => {
  it('matches the shape in the spec exactly', () => {
    expect(format(issues, { color: false, fixHint: true })).toBe(
      `⚠ pulled: your local setup is out of sync with the code
  • Dependencies: 3 packages differ from package-lock.json
      express 4.19.2 → 4.21.1, zod (not installed), +1 more
      → npm install
  • Prisma schema changed since the client was generated
      → npx prisma generate
  • Missing in .env: JWT_SECRET, REDIS_URL
      → add them to .env (see .env.example)
  Run \`npx pulled --fix\` to fix what can be fixed automatically.
`,
    );
  });

  it('prints nothing when there are no issues', () => {
    expect(format([], { color: true, fixHint: true })).toBe('');
  });

  it('omits the --fix line when nothing is auto-fixable', () => {
    const out = format([issues[2] as Issue], { color: false, fixHint: true });
    expect(out).not.toContain('--fix');
  });

  it('omits the --fix line when asked to', () => {
    expect(format(issues, { color: false, fixHint: false })).not.toContain('--fix');
  });

  it('adds ANSI colors only when enabled', () => {
    expect(format(issues, { color: false, fixHint: true })).not.toContain('\x1b[');
    expect(format(issues, { color: true, fixHint: true })).toContain('\x1b[');
  });
});

describe('useColor', () => {
  it('needs a TTY and NO_COLOR unset', () => {
    expect(useColor({ isTTY: true }, {})).toBe(true);
    expect(useColor({ isTTY: false }, {})).toBe(false);
    expect(useColor({}, {})).toBe(false);
    expect(useColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(useColor({ isTTY: true }, { NO_COLOR: '' })).toBe(false);
  });
});
