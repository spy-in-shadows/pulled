# Real-world test (release gate)

Date: 2026-11-22. Project under test: Pawnprint, a private Express + Prisma 5.22 + PostgreSQL app
(npm, single `prisma/schema.prisma` with `prisma-client-js`, `url = env("DATABASE_URL")`, 6 migrations,
`.env.example` with 12 keys, no `.nvmrc`). Tested on a throwaway clone in `/tmp/pawnprint-test`; the
original repo was never modified. Node 26.5.0, npm 11.17.0, macOS.

## Verdict

**Pass** with pulled at `f3a6706`, after fixing three bugs the first run found (below). In every run,
every warning matched a real change in `git diff`, nothing that changed was missed, the warnings cleared
after `npx pulled --fix` (plus filling in `.env`, which is never auto-fixed), and import mode was silent
afterwards.

## Bugs found and fixed

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | The Prisma warning stayed after `prisma generate`. Prisma's formatter sorts block attributes (`@@unique` before `@@index` before `@@map`) and moves comments between them, so the "each stripped source file is a substring of the generated copy" rule never matched a schema written in another order. Verified on Prisma 5.22, 6.19 and 7.10. | Release-blocking (false positive that survives the fix) | `5e664b0`: compare whitespace-stripped lines tagged with their block, in any order. SPEC §5 and §13.1. |
| 2 | With a database that answers, `npx pulled` printed nothing and exited 0, even with pending migrations **and** a stale Prisma client. The query's socket and timer were unref'd in every mode, so once connected nothing held the CLI's event loop and Node exited mid-query. Same for a script that only awaits `check()` from `pulled/api`. | Release-blocking (silently misses everything) | `f3a6706`: unref only in import mode (as SPEC §2 says). New e2e cases with a fake `pg` run in CI. SPEC §13.3. |
| 3 | `PULLED_DEBUG=1` printed `query to localhost:5435 failed: ` with no reason (a refused `localhost` connection is an `AggregateError` with an empty message). | Minor (debug output only) | `59729f3`: fall back to the error code (`ECONNREFUSED`). SPEC §13.2. |

Each fix has a test that fails without it. Bug 2 wasn't caught before because vitest keeps its process
alive and CI has no database; the new e2e cases reproduce it without one.

## Setup

Outputs below are from the final runs. Trimmed: Prisma's "Environment variables loaded", tip and
update banners, npm's funding/audit and `allow-scripts` lines, and `skipped` entries in JSON condensed onto
one line. pulled's own output is verbatim. No secrets appear (the throwaway database URL is redacted too).

```sh
git clone ~/Desktop/Pawnprint /tmp/pawnprint-test
cp ~/Desktop/Pawnprint/.env /tmp/pawnprint-test/.env      # no .env.local exists; values never printed
npm pack                                                   # in this repo
npm i -D <path>/pulled-0.1.0.tgz                           # in the copy
```

**Choice of the old commit.** None of the last 15 commits touch `package-lock.json`, `package.json`,
`prisma/schema.prisma`, `prisma/migrations` or `.env.example` (the repo has no merge commits). The most
recent changes to those files are the two schema + migration commits 43–44 back, so the old commit is
`ee6226b` (45 back), just before them:

```sh
git checkout ee6226b && npm i && npx prisma generate
npx pulled            # silent, exit 0
git checkout main     # cf570a5
git diff ee6226b..main --stat -- package.json package-lock.json prisma/schema.prisma prisma/migrations .env.example .nvmrc .node-version
 .../20261114161727_analytics_indexes/migration.sql |  6 ++++
 .../20261114162509_account_summaries/migration.sql | 36 +++++++++++++++++++
 prisma/schema.prisma                               | 40 ++++++++++++++++++++++
 3 files changed, 82 insertions(+)
```

**Database.** The copied `.env` points at Pawnprint's docker-compose database (`localhost:5435`), which
wasn't running, so `prisma migrate deploy` couldn't run there and the migrations check skips (run 1).
Run 2 repeats the test with only the copy's `DATABASE_URL` pointed at a throwaway local Postgres, so the
migrations check gets real coverage. Your real database was never touched.

## Run 1: copied `.env` as is (database down)

```
$ npx pulled
⚠ pulled: your local setup is out of sync with the code
  • Prisma schema changed since the client was generated
      → npx prisma generate
  Run `npx pulled --fix` to fix what can be fixed automatically.
[exit 1]
$ npx pulled --json
{
  "ok": false,
  "issues": [
    {
      "id": "prisma-client",
      "title": "Prisma schema changed since the client was generated",
      "details": [],
      "fix": "npx prisma generate"
    }
  ],
  "skipped": [
    { "id": "node", "reason": "no .nvmrc or .node-version" },
    { "id": "migrations", "reason": "could not query the database" }
  ]
}
[exit 1]
$ PULLED_DEBUG=1 npx pulled   (migrations lines)
[pulled] migrations: query to localhost:5435 failed: ECONNREFUSED
[pulled] migrations: 12.1 ms (skipped: could not query the database)
$ npx pulled --fix
→ npx prisma generate
✔ Generated Prisma Client (v5.22.0) to ./node_modules/@prisma/client in 73ms
[exit 0]
$ npx pulled
[exit 0]
$ node --import pulled -e "setTimeout(()=>{},300)"
[exit 0]
```

Compared with the diff: schema changed → reported. Lockfile, `package.json` and `.env.example`
unchanged → nothing reported. No `.nvmrc` → node skipped. Migrations can't be checked without the
database → skipped silently (correct: no false positive).

Before the fixes, `npx pulled` after `--fix` still printed the Prisma warning (bug 1).

## Run 2: migrations against a throwaway Postgres

```sh
# copy only: DATABASE_URL=<throwaway local database>
git checkout ee6226b && npx prisma generate && npx prisma migrate deploy   # 4 migrations applied
npx pulled            # silent, exit 0
git checkout main
```

```
$ npx pulled
⚠ pulled: your local setup is out of sync with the code
  • Prisma schema changed since the client was generated
      → npx prisma generate
  • 2 migrations not applied: 20261114161727_analytics_indexes, 20261114162509_account_summaries
      → npx prisma migrate dev
  Run `npx pulled --fix` to fix what can be fixed automatically.
[exit 1]
$ npx pulled --json
{
  "ok": false,
  "issues": [
    {
      "id": "prisma-client",
      "title": "Prisma schema changed since the client was generated",
      "details": [],
      "fix": "npx prisma generate"
    },
    {
      "id": "migrations",
      "title": "2 migrations not applied: 20261114161727_analytics_indexes, 20261114162509_account_summaries",
      "details": [],
      "fix": "npx prisma migrate dev"
    }
  ],
  "skipped": [{ "id": "node", "reason": "no .nvmrc or .node-version" }]
}
[exit 1]
$ node --import pulled -e "setTimeout(()=>{},300)"   (before the fix)
⚠ pulled: your local setup is out of sync with the code
  • Prisma schema changed since the client was generated
      → npx prisma generate
  Run `npx pulled --fix` to fix what can be fixed automatically.
⚠ pulled: your local setup is out of sync with the code
  • 2 migrations not applied: 20261114161727_analytics_indexes, 20261114162509_account_summaries
      → npx prisma migrate dev
  Run `npx pulled --fix` to fix what can be fixed automatically.
[exit 0]
$ npx pulled --fix
→ npx prisma generate
✔ Generated Prisma Client (v5.22.0) to ./node_modules/@prisma/client in 56ms
→ npx prisma migrate deploy
Datasource "db": PostgreSQL database "pawnprint", schema "public" at "<redacted>"
6 migrations found in prisma/migrations
Applying migration `20261114161727_analytics_indexes`
Applying migration `20261114162509_account_summaries`
All migrations have been successfully applied.
[exit 0]
$ npx pulled
[exit 0]
$ node --import pulled -e "setTimeout(()=>{},300)"
[exit 0]
```

Both pending migrations are exactly the two folders in the diff. Import mode prints the migrations
result as its own block after the sync checks (SPEC §2).

Before the fixes, `npx pulled` here printed nothing and exited 0 (bug 2).

## Run 3: a teammate changes a dependency and `.env.example`

The history has no dependency or `.env.example` change to test, so a teammate commit was simulated: in a
separate clone, `npm i --package-lock-only express@5.1.0` (installed: 5.3.0) and two new keys in
`.env.example` (`REDIS_URL=` and `SENTRY_DSN= # optional`), committed, then `git pull` in the copy.

```
$ git diff HEAD~1..HEAD --stat
 .env.example      |  2 ++
 package-lock.json | 36 ++++++++++++++++++++++--------------
 package.json      |  2 +-
$ npx pulled
⚠ pulled: your local setup is out of sync with the code
  • Dependencies: 3 packages differ from package-lock.json
      express 5.3.0 → 5.1.0, content-disposition 2.0.1 → 1.1.0, content-type (not installed)
      → npm install
  • Missing in .env: REDIS_URL
      → add them to .env (see .env.example)
  Run `npx pulled --fix` to fix what can be fixed automatically.
[exit 1]
$ npx pulled --fix
→ npm install
added 1 package, changed 2 packages, and audited 152 packages in 436ms
⚠ pulled: your local setup is out of sync with the code
  • Missing in .env: REDIS_URL
      → add them to .env (see .env.example)
[exit 1]
$ echo "REDIS_URL=" >> .env      # the user fills it in
$ npx pulled
[exit 0]
$ node --import pulled -e "setTimeout(()=>{},300)"
[exit 0]
```

The three packages are exactly the lockfile entries that changed (express, content-disposition and a new
nested content-type). The `# optional` key isn't reported, and `.env` is correctly not auto-fixed.

## Notes

- npm 11's `npm i --package-lock-only` also rewrites `node_modules/.package-lock.json` to match the new
  lockfile without installing anything. If you run it **yourself**, pulled trusts the hidden lockfile and
  stays silent about the difference. A `git pull` never touches node_modules, so this doesn't affect the
  pull case pulled is built for; it was found while setting up run 3 and is left as specified (SPEC §5).
- `npm install` in the copy printed npm 11's `allow-scripts` warnings (install scripts are blocked by
  default), which is why `prisma generate` had to be run by hand after installing.
