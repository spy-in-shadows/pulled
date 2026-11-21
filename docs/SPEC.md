We're building `pulled`, a small zero-dependency npm package. Its job: when a developer pulls new code and their local setup is now out of sync with it, tell them exactly what's out of sync and the one command that fixes it — instead of them debugging a confusing runtime error.

The spec below is final. Don't add features, checks or flags that aren't in it. If something in it turns out to be technically impossible or wrong, stop and tell me instead of improvising.

Before writing any code, save this spec verbatim as docs/SPEC.md and add a short CLAUDE.md that points to it and lists the Principles section, so future sessions follow it.

# 1. Principles (these override everything else)

1. Silent when everything is in sync. Zero output, zero noise.
2. No false positives. If a check can't be sure, it stays silent. A warning that is still shown AFTER the user ran the suggested fix command is a release-blocking bug.
3. Never break the host app. pulled never throws into the host process, never calls process.exit in import mode (except strict mode, see section 4), and swallows its own errors. Set PULLED_DEBUG=1 to print internal errors and timings.
4. Never print secret values. Env checks print key names only.
5. No stored state and no git hooks. Every check compares a source file with the real thing on disk (or in the DB). No cache files, no .git writes, no dependency on git being installed.
6. Zero runtime dependencies. No network access except the optional migrations DB query.
7. Fast. All synchronous checks together must take < 25 ms on a project with ~1000 lockfile entries. Add a benchmark script that measures this.

# 2. How users run it

- `import 'pulled'` (ESM) or `require('pulled')` (CJS) as the first line of their dev entry file.
- `node --import pulled server.js` (no code change), e.g. `"dev": "node --import pulled --watch server.js"`.
- CLI: `npx pulled` — runs every check, prints the report, exits 0 (in sync), 1 (out of sync) or 2 (internal error). Flags, and nothing else: `--fix`, `--json`, `--cwd <dir>`, `--help`, `--version`.
- Programmatic: `import { check } from 'pulled/api'` → `Promise<Report>`, where `Report = { ok: boolean, issues: Issue[], skipped: { id: CheckId, reason: string }[] }` and `Issue = { id: CheckId, title: string, details: string[], fix?: string }`. Export these types.

Import mode is skipped entirely when NODE_ENV === 'production', when CI is truthy, or when PULLED is '0' / 'false' / 'off'. The CLI ignores NODE_ENV and CI, so it works as a CI step or a `predev` script.

Import mode runs the synchronous checks immediately and prints at most once per process. The async migrations check runs afterwards and prints its own small block only if it finds pending migrations. Its timers and sockets must be unref'd so the host process can still exit normally.

# 3. Project root

Walk up from process.cwd() (or --cwd) to the nearest package.json: that's the package dir. Keep walking up to find the lockfile and node_modules, so npm/pnpm/yarn workspaces with a root lockfile work. Use the root's package.json `packageManager` field and the lockfile type to decide which package manager to use in fix commands.

# 4. Config (optional), in package.json

"pulled": {
  "skip": ["migrations"],            // any check ids
  "strict": false,                   // import mode: print, then process.exit(1) if the sync checks find issues
  "envExample": ".env.example"       // override the example file
}
Validate the config; ignore unknown keys and warn about them under PULLED_DEBUG only.

# 5. The five checks (exactly these, ids in backticks)

## `deps` — node_modules vs lockfile
- npm (package-lock.json v2/v3): compare each entry in lockfile `packages` (skip the "" root entry and `link: true` entries) with node_modules/.package-lock.json (npm's hidden lockfile). For entries that are missing or have a different version there, confirm by reading node_modules/<path>/package.json `version`. An entry is stale only if that real version is missing or different.
  - Entries marked `optional: true` or `devOptional: true` that aren't installed are NOT issues. This includes platform-specific binaries like @esbuild/linux-x64 on macOS. This is the main false-positive trap; test it.
  - If package-lock.json has `dev: true` entries and the hidden lockfile has none of them, dev deps were omitted on purpose (`omit=dev`, `--omit=dev`, NODE_ENV=production at install time): ignore uninstalled `dev: true` entries. Applies in import mode and the CLI.
  - If node_modules is missing entirely → "Dependencies are not installed".
  - Also flag direct deps in package.json (dependencies, devDependencies, optionalDependencies) that are missing from the lockfile root entry → "package.json changed but the lockfile wasn't updated".
  - Report a count plus at most 3 examples, e.g. `express 4.19.2 → 4.21.1` (installed → expected), `zod (not installed)`.
- pnpm: compare pnpm-lock.yaml with node_modules/.pnpm/lock.yaml, both with `\r` stripped. If they differ but node_modules/.modules.yaml `included` shows `devDependencies: false` or `optionalDependencies: false` (a filtered install), stay silent. Issue (one line, no per-package examples): "Dependencies: pnpm-lock.yaml changed since the last install".
- yarn v1: parse yarn.lock into { pattern → resolved } and compare it with `lockfileEntries` in node_modules/.yarn-integrity. Patterns without `resolved` are ignored on both sides.
- yarn berry / PnP: skip with reason "yarn berry not supported yet".
- Fix: `npm install` / `pnpm install` / `yarn`.

## `node` — Node version
- Read .nvmrc, then .node-version. Accept forms like "22", "v22", "22.11.0". Skip aliases like "lts/*", "lts/jod", "node" (with a skip reason).
- Compare the MAJOR version only with process.versions.node.
- Issue: "Project expects Node 22, you're on 20.11.1". Fix: `nvm use` if .nvmrc exists, otherwise "switch to Node 22".

## `env` — .env vs example
- Example file: the config value, otherwise the first of .env.example, .env.sample, .env.template in the package dir. No example file → skip.
- Parse keys with a small, careful dotenv-style parser: KEY=VALUE, optional `export ` prefix, quoted values (including multiline double-quoted values), `#` comments, blank lines. Never evaluate or expand anything.
- A key is present if it's in .env, .env.local, or process.env (so CI and shell-exported vars count). Empty values count as present.
- Keys marked with a trailing `# optional` comment on their line in the example file are not required.
- Issues: ".env file is missing" (fix: `cp .env.example .env`, then fill it in), or "Missing in .env: JWT_SECRET, REDIS_URL" (fix: "add them to .env (see .env.example)").
- Never read or print values.

## `prisma-client` — generated client vs schema
- Only runs if `prisma` or `@prisma/client` is a dependency.
- Find the schema in this order: package.json `prisma.schema`, a path in prisma.config.ts/.js/.mjs (extract string literals with a conservative regex — never execute the config), then prisma/schema.prisma, then a prisma/ folder of multiple .prisma files (Prisma's multi-file schema).
- Find the generator output: parse each `generator` block's `provider` and `output`. `prisma-client` (Prisma 7) → the output path, relative to the .prisma file containing that generator block. `prisma-client-js` without output → resolve `@prisma/client/package.json` from the project root with createRequire, realpath it, and use the sibling `.prisma/client` (i.e. `<realpath of @prisma/client>/../../.prisma/client`). This works for npm, yarn and pnpm's isolated layout.
- Generated schema: `prisma-client-js` → `<output>/schema.prisma` (a formatted copy). `prisma-client` → the `"inlineSchema": "<JSON string>"` literal in `<output>/internal/class.{ts,mts,cts,js,mjs,cjs}`, extracted with a regex and JSON.parse'd.
- Staleness signal: strip all whitespace from the generated schema and from each source schema file. In sync only if every stripped source file occurs as a substring of the stripped generated schema AND the sum of the stripped source lengths equals the stripped generated length (order-independent, because Prisma concatenates multi-file schemas in no fixed order and formats the copy). No mtime fallback.
- Issues: "Prisma client was never generated" or "Prisma schema changed since the client was generated". Fix: `npx prisma generate` (or the pnpm/yarn equivalent).

## `migrations` — pending Prisma migrations (async)
- Only runs if the migrations dir exists (prisma/migrations next to the schema, or a path found in prisma.config.*) and the datasource provider is postgresql. Other providers → skip with a reason.
- Env var name, in this order: `url = env("X")` in the schema datasource (Prisma 6) → in prisma.config.*, conservatively extract `env("X")` / `env('X')` / `process.env.X` and use it only if exactly ONE distinct name is found → otherwise DATABASE_URL. Never execute the config.
- Connection string: process.env[name], otherwise that name parsed from .env (don't mutate process.env). None found → skip.
- Resolve `pg` from the project root with createRequire. Not installed → skip with reason "install pg to enable".
- Query `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`, with a 1500 ms total timeout. On any error (DB down, auth, SSL, missing table) stay silent; PULLED_DEBUG shows why.
- Pending = migration folder names (directories that contain migration.sql) not in that result.
- Issue: "2 migrations not applied: 20261120_add_users, 20261121_add_index". Fix: `npx prisma migrate dev`.

# 6. Output format

Write to stderr only. Use colors only when stderr is a TTY and NO_COLOR is unset. No emoji except the one leading ⚠. Exact shape:

⚠ pulled: your local setup is out of sync with the code
  • Dependencies: 3 packages differ from package-lock.json
      express 4.19.2 → 4.21.1, zod (not installed), +1 more
      → npm install
  • Prisma schema changed since the client was generated
      → npx prisma generate
  • Missing in .env: JWT_SECRET, REDIS_URL
      → add them to .env (see .env.example)
  Run `npx pulled --fix` to fix what can be fixed automatically.

Only show the last line if at least one issue is auto-fixable. `--json` prints the Report as JSON to stdout with no other output.

# 7. --fix (CLI only)

Run the fixable steps in this order, streaming their output: deps install → prisma generate → `prisma migrate deploy` (deploy, not dev: it never resets the DB). env and node issues are never auto-fixed. After fixing, run all checks again and print the final report. Exit 0 only if everything is in sync. Run commands with spawn and inherited stdio, never through a shell string.

# 8. Tech & repo layout

- TypeScript (strict). Build with tsup to dist/ as ESM + CJS + .d.ts. Test with vitest. Lint/format with whatever is smallest (biome is fine). Those are devDependencies only.
- package.json:
  - "exports": "." (side-effect entry: import + require), "./api", "./package.json"
  - "bin": { "pulled": "dist/cli.js" }
  - "engines": { "node": ">=20.6" } (the first version with --import)
  - "files": ["dist"], "sideEffects": true, MIT license, good keywords, version 0.1.0
- src/: index.ts (side-effect runner), api.ts, cli.ts, report.ts (formatting), checks/{deps,node,env,prismaClient,migrations}.ts, util/ (root finding, dotenv parser, prisma schema parsing, package-manager detection).
- Each check is a pure-ish function: (ctx) => CheckResult | Promise<CheckResult>, taking an injected fs/env context so tests can use temp-dir fixtures.

# 9. Workflow (stop where it says STOP)

Phase 0 — verify assumptions, no product code yet. Use a scratch folder outside the repo:
  a) Run `npm view pulled`. If the name is taken, tell me and propose 3 alternatives. The bin name stays `pulled` either way.
  b) npm: confirm how node_modules/.package-lock.json behaves after install, after a no-op install, and with optional platform deps.
  c) pnpm and yarn v1 (if available on this machine): find a stale-detection method that clears after a no-op `install` when the lockfile was only touched or re-checked-out.
  d) Prisma 6 (prisma-client-js) and Prisma 7 (prisma-client with output): run generate and inspect the output. Is there a schema copy or hash? Does it change only when the schema changes?
  Write the findings to docs/FINDINGS.md, then STOP and summarize them for me.

Phase 1 — scaffold: package.json, tsconfig, tsup, vitest, lint, CI workflow (GitHub Actions: Node 20, 22, 24 on ubuntu + macos; current vitest), LICENSE, a .gitignore. Commit.

Phase 2 — the checks, one commit each, in order: node, env, deps, prisma-client, migrations. Each check gets fixture-based tests for: in sync (silent), each issue type, each skip reason, and the "user ran the fix → silent again" case. The prisma-client tests also cover: a multi-file schema with files reordered (silent), a field being added (issue), and whitespace-only edits (silent). The migrations tests use an injected fake query function. Real-DB tests run only when PULLED_TEST_DATABASE_URL is set.

Phase 3 — report formatting, import-mode entry (ESM + CJS + --import), CLI with --json/--fix/--cwd, strict mode, the env/CI/PULLED skip logic, the benchmark script. Also add one e2e test script that packs the package (`npm pack`), installs it into a temp project and runs it in all three activation modes.

Phase 4 — README. Sections:
  - one-sentence pitch and a short "you pulled, the app crashed with `column "x" does not exist`" story
  - install + one-line usage
  - example output
  - a table of what it checks
  - CLI flags
  - config
  - FAQ: why not git hooks, does it slow startup (give the measured number), does it run in production
  - an honest "How is this different from stale-dep / lockfile-guardian?" section: they only check dependencies and need hooks or stored hashes; pulled checks your whole setup with no setup step.
  Then run `npm pack --dry-run` and show me the file list and size. Do NOT publish. I'll publish myself.

Commit after each phase, with conventional commit messages. Keep the code small and readable; this package should stay well under ~1000 lines of source.

# 10. Phase 0 decisions (2026-11-21)

Based on docs/FINDINGS.md. The spec body above has been updated to match; this section records why.

1. npm omit=dev: if package-lock.json has `dev: true` entries and the hidden lockfile has none of them, ignore uninstalled dev entries. Treat `devOptional` like `optional`. Applies to import mode and the CLI. (Otherwise `omit=dev` in .npmrc gives a warning that `npm install` never clears.)
2. pnpm: compare pnpm-lock.yaml with node_modules/.pnpm/lock.yaml with `\r` stripped; stay silent on filtered installs per .modules.yaml `included`; one-line issue without per-package examples, titled "Dependencies: pnpm-lock.yaml changed since the last install".
3. yarn v1: compare yarn.lock against `lockfileEntries` in node_modules/.yarn-integrity.
4. Prisma staleness: strip all whitespace; compare against the Prisma 6 `schema.prisma` copy / Prisma 7 `inlineSchema`; no mtime fallback. Multi-file is order-independent: every stripped source file must occur as a substring of the stripped generated schema, AND the sum of stripped source lengths must equal the stripped generated length. Tests: files reordered (silent), field added (issue), whitespace-only edit (silent).
5. Prisma client location (all package managers): resolve @prisma/client from the project root with createRequire + realpath, then use the sibling .prisma/client. There is no "root node_modules/.prisma/client" assumption (it doesn't exist under pnpm).
6. Migrations DB URL env var: `env("X")` in the schema datasource (Prisma 6) → in prisma.config.*, conservatively extract `env("X")` / `env('X')` / `process.env.X`, used only if exactly one distinct name is found → otherwise DATABASE_URL. Never execute the config.
7. Wording: Prisma issue title "Prisma schema changed since the client was generated" (sections 5 and 6). Env fix text "add them to .env (see .env.example)".
8. Node support: engines ">=20.6" (first version with --import). CI on Node 20, 22, 24 on ubuntu + macos. Current vitest.
