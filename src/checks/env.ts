import { join } from 'node:path';
import type { CheckResult, Context } from '../types';
import { parseDotenv } from '../util/dotenv';

const EXAMPLES = ['.env.example', '.env.sample', '.env.template'];

/** `env`: every required key in the example file must exist in .env, .env.local or process.env. */
export function envCheck(ctx: Context): CheckResult {
  const { fs, pkgDir } = ctx;
  const example = ctx.config.envExample ?? EXAMPLES.find((f) => fs.exists(join(pkgDir, f)));
  const exampleText = example === undefined ? undefined : fs.read(join(pkgDir, example));
  if (example === undefined || exampleText === undefined) {
    return { issues: [], skip: `no ${example ?? '.env.example'} file` };
  }

  const required = parseDotenv(exampleText)
    .filter((e) => !e.optional)
    .map((e) => e.key);
  const envText = fs.read(join(pkgDir, '.env'));
  const present = new Set<string>();
  for (const file of [envText, fs.read(join(pkgDir, '.env.local'))]) {
    for (const entry of parseDotenv(file ?? '')) present.add(entry.key);
  }
  const missing = [...new Set(required)].filter(
    (key) => !present.has(key) && ctx.env[key] === undefined,
  );
  if (missing.length === 0) return { issues: [] };

  if (envText === undefined) {
    return {
      issues: [
        {
          id: 'env',
          title: '.env file is missing',
          details: [],
          fix: `cp ${example} .env, then fill it in`,
        },
      ],
    };
  }
  return {
    issues: [
      {
        id: 'env',
        title: `Missing in .env: ${missing.join(', ')}`,
        details: [],
        fix: `add them to .env (see ${example})`,
      },
    ],
  };
}
