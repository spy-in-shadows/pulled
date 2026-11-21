export interface DotenvEntry {
  key: string;
  value: string;
  /** The line has a trailing `# optional` comment. */
  optional: boolean;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=[ \t]*(.*)$/;

/**
 * Small dotenv-style parser: KEY=VALUE, optional `export ` prefix, quoted values (multiline when
 * the closing quote is on a later line), `#` comments and blank lines. Nothing is expanded or
 * evaluated. An unterminated quote is treated as a plain single-line value.
 */
export function parseDotenv(src: string): DotenvEntry[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const entries: DotenvEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i] ?? '');
    if (!m) continue;
    const key = m[1] as string;
    const rest = m[2] as string;
    let value: string;
    let tail = '';
    const quote = rest[0];
    const closed =
      quote === '"' || quote === "'" || quote === '`' ? findQuoted(lines, i, quote) : undefined;
    if (closed) {
      value = closed.value;
      tail = closed.tail;
      i = closed.line;
    } else if (rest.startsWith('#')) {
      value = '';
      tail = rest;
    } else {
      const hash = rest.search(/\s#/);
      value = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
      tail = hash >= 0 ? rest.slice(hash) : '';
    }
    entries.push({ key, value, optional: /^\s*#\s*optional\b/i.test(tail) });
  }
  return entries;
}

function findQuoted(lines: string[], start: number, quote: string) {
  const first = LINE.exec(lines[start] ?? '')?.[2] ?? '';
  let body = first.slice(1);
  for (let line = start; ; ) {
    const end = closingIndex(body, quote);
    if (end >= 0) {
      let value = body.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
      return { value, tail: body.slice(end + 1), line };
    }
    if (++line >= lines.length) return undefined;
    body += `\n${lines[line]}`;
  }
}

function closingIndex(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === '\\') i++;
    else if (body[i] === quote) return i;
  }
  return -1;
}
