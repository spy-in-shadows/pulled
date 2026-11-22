# pulled

[![npm version](https://img.shields.io/npm/v/pulled.svg)](https://www.npmjs.com/package/pulled)

After you pull, `pulled` tells you exactly what in your local setup is out of sync with the code (dependencies, Node version, `.env`, Prisma client, migrations) and the one command that fixes it.

You pull `main`, start the dev server, and the first request dies with `column "avatar_url" does not exist`. Ten minutes later you work out that a teammate added a migration and you never ran it. With `pulled`, the dev server would have told you at startup:

```
⚠ pulled: your local setup is out of sync with the code
  • 1 migration not applied: 20261121_add_avatar_url
      → npx prisma migrate dev
  Run `npx pulled --fix` to fix what can be fixed automatically.
```

When everything is in sync it prints nothing at all.

## Demo

Try it in the browser: **https://pulled-demo.onrender.com**. Six small example
projects (in sync, stale dependencies, missing `.env` keys, a different Node version, a changed Prisma
schema, and all of it at once), each checked live. Source:
[spy-in-shadows/pulled-demo](https://github.com/spy-in-shadows/pulled-demo).

## Install

```sh
npm install --save-dev pulled
```

Then add one line at the top of your dev entry file:

```js
import 'pulled'; // or require('pulled')
```

Or change nothing in your code and load it from your dev script:

```json
"dev": "node --import pulled --watch server.js"
```

Or run it by hand, in CI or as a `predev` script:

```sh
npx pulled
```

pulled has zero runtime dependencies and needs Node 20.6 or newer.

## Example output

```
⚠ pulled: your local setup is out of sync with the code
  • Dependencies: 3 packages differ from package-lock.json
      express 4.19.2 → 4.21.1, zod (not installed), +1 more
      → npm install
  • Prisma schema changed since the client was generated
      → npx prisma generate
  • Missing in .env: JWT_SECRET, REDIS_URL
      → add them to .env (see .env.example)
  Run `npx pulled --fix` to fix what can be fixed automatically.
```

Output goes to stderr. It's colored only when stderr is a terminal and `NO_COLOR` is unset.

## What it checks

| Check | Compares | Fix it suggests |
|---|---|---|
| `deps` | `node_modules` with your lockfile: npm (`package-lock.json` v2/v3), pnpm and yarn v1. Uninstalled optional and platform-specific packages aren't flagged, and neither are dev dependencies left out on purpose (`--omit=dev`). Also catches dependencies added to `package.json` but missing from the lockfile. yarn berry isn't supported yet. | `npm install` / `pnpm install` / `yarn` |
| `node` | The major version in `.nvmrc` or `.node-version` with the Node you're running. Aliases like `lts/*` are skipped. | `nvm use` |
| `env` | The keys in `.env.example` (or `.env.sample` / `.env.template`) with `.env`, `.env.local` and your shell environment. A key marked `# optional` in the example isn't required. Only key names are ever printed, never values. | add them to `.env` |
| `prisma-client` | The generated Prisma client with your schema (Prisma 6 `prisma-client-js` and Prisma 7 `prisma-client`, single- or multi-file). Formatting and whitespace changes don't count. | `npx prisma generate` |
| `migrations` | The folders in `prisma/migrations` with the `_prisma_migrations` table in your database. PostgreSQL only, and only if `pg` is installed in your project. The database is the one your datasource `url` names, in `schema.prisma` or the `url:` key of `prisma.config.ts` (never executed); if that's unclear, the check is skipped. | `npx prisma migrate dev` |

Fix commands use your package manager, for example `pnpm exec prisma generate`.

Every check compares a source file with what's actually on disk (or in the database). There is no cache, no stored state and nothing to set up. If a check can't be sure, it stays silent.

## CLI

```
npx pulled [options]
```

| Flag | |
|---|---|
| `--fix` | Run the fix commands in order (install → `prisma generate` → `prisma migrate deploy`), streaming their output, then check again and print what's left. `.env` and Node version issues are never fixed automatically. `migrate deploy` is used instead of `migrate dev` because it never resets your database. |
| `--json` | Print the report as JSON to stdout, and nothing else. |
| `--cwd <dir>` | Check the project in `<dir>` instead of the current directory. |
| `--help` | Show help. |
| `--version` | Show the version. |

Exit codes: `0` in sync, `1` out of sync, `2` internal error.

There's also a programmatic API:

```js
import { check } from 'pulled/api';

const report = await check(); // { ok, issues: [{ id, title, details, fix }], skipped: [{ id, reason }] }
```

## Config

Optional, in `package.json`:

```json
"pulled": {
  "skip": ["migrations"],
  "strict": false,
  "envExample": ".env.example"
}
```

- `skip`: check ids to turn off (`deps`, `node`, `env`, `prisma-client`, `migrations`).
- `strict`: in import mode, print the report and exit with code 1 if the synchronous checks find issues, so your app doesn't start out of sync.
- `envExample`: the example file to compare `.env` with.

Environment variables:

- `PULLED=0` (or `false` / `off`) turns pulled off: import mode does nothing, and the CLI exits 0 with no output (no JSON either).
- `PULLED_DEBUG=1` prints timings, skipped checks and the reasons, and internal errors.

## FAQ

**Why not git hooks?**
Hooks have to be installed in every clone and are easy to bypass. They also only run on the git events they're wired to: a `post-merge` hook doesn't fire on a rebase or a `git stash pop`, for example. And they can't see changes that don't come from git at all, like a switched Node version or a wiped `node_modules`. pulled doesn't depend on git. It compares what the code expects with what's actually installed, every time your app starts.

**Does it slow startup?**
Barely. The synchronous checks take about 4 ms on a project with 1,000 lockfile entries. In the worst case, when npm's hidden lockfile is missing and pulled has to read every installed `package.json`, they take about 18 ms. Loading pulled plus running the checks adds 4–7 ms to `node` startup on small projects. The migrations check runs after your app has started and doesn't block it. `npm run bench` measures this on your machine.

**Does it run in production?**
No. Import mode does nothing when `NODE_ENV=production` or `CI` is set (or `PULLED=0`). It's meant to be a dev dependency anyway. The CLI ignores `NODE_ENV` and `CI` (only `PULLED=0` turns it off), so you can run `npx pulled` as a CI step.

**Can the migrations check delay my app's exit?**
Only when the database host doesn't answer at all, and then by at most 1.5 s. The query runs in the background with a 1.5 s timeout and never keeps your process alive on its own, except while a TCP connection is still being set up, which Node can't release. When that happens, pulled closes the connection itself once the timeout hits. Measured: an unreachable host (for example a firewalled IP) delays exit by about 1.5 s, a database that's down (connection refused) by about 0.05 s, and a reachable local database not at all. The timeout isn't shorter because cloud dev databases can take more than half a second to wake up. If the check can't reach the database for any reason, it stays silent (`PULLED_DEBUG=1` shows why, with the host only, never the connection string).

## How is this different from stale-dep / lockfile-guardian?

They check dependencies only, and they work by installing git hooks or storing a hash of your lockfile, which then has to stay in step with reality. pulled checks your whole local setup (dependencies, Node version, `.env`, Prisma client and migrations) by comparing the source files with what's actually installed. There's no setup step, no hook and no stored state, so it can't drift and it works the same after a pull, a branch switch or a fresh clone.

## License

MIT
