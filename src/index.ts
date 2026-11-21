// Side-effect entry: `import 'pulled'`, `require('pulled')`, `node --import pulled`.

import { format, useColor } from './report';
import { runMigrations, runSync } from './run';
import type { Issue } from './types';
import { createContext, importModeDisabled } from './util/context';

function run(): void {
  // At most once per process, even if both the ESM and CJS builds get loaded.
  const key = Symbol.for('pulled.importMode');
  const g = globalThis as Record<symbol, unknown>;
  if (g[key]) return;
  g[key] = true;

  const env = process.env;
  if (importModeDisabled(env)) return;
  const start = performance.now();
  const ctx = createContext({ env });
  if (!ctx) return;
  const print = (issues: Issue[]) => {
    const text = format(issues, { color: useColor(process.stderr, env), fixHint: true });
    if (text) process.stderr.write(text);
  };

  const report = runSync(ctx);
  ctx.debug(`sync checks: ${(performance.now() - start).toFixed(1)} ms`);
  print(report.issues);
  if (ctx.config.strict && !report.ok) process.exit(1);

  runMigrations(ctx).then(
    (r) => print(r.issues),
    (err) => ctx.debug(`migrations: internal error: ${err}`),
  );
}

try {
  run();
} catch (err) {
  if (process.env.PULLED_DEBUG && process.env.PULLED_DEBUG !== '0') {
    process.stderr.write(`[pulled] internal error: ${(err as Error)?.stack ?? err}\n`);
  }
}
