import type { CheckId, Issue } from './types';

/** Checks whose fix command `pulled --fix` can run. */
export const FIXABLE: CheckId[] = ['deps', 'prisma-client', 'migrations'];

export const isFixable = (issue: Issue) => issue.fix !== undefined && FIXABLE.includes(issue.id);

/** Colors only on a TTY with NO_COLOR unset. */
export function useColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>) {
  return stream.isTTY === true && env.NO_COLOR === undefined;
}

/** The human-readable block (section 6 of the spec). Empty string when there are no issues. */
export function format(issues: Issue[], opts: { color: boolean; fixHint: boolean }): string {
  if (issues.length === 0) return '';
  const paint = (code: string) => (s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const [yellow, bold, dim, cyan] = [paint('33'), paint('1'), paint('2'), paint('36')];

  const lines = [yellow(bold('⚠ pulled: your local setup is out of sync with the code'))];
  for (const issue of issues) {
    lines.push(`  • ${bold(issue.title)}`);
    for (const detail of issue.details) lines.push(`      ${dim(detail)}`);
    if (issue.fix) lines.push(`      ${cyan(`→ ${issue.fix}`)}`);
  }
  if (opts.fixHint && issues.some(isFixable)) {
    lines.push('  Run `npx pulled --fix` to fix what can be fixed automatically.');
  }
  return `${lines.join('\n')}\n`;
}
