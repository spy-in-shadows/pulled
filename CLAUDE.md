# pulled

The full, final spec is in [docs/SPEC.md](docs/SPEC.md). Read it before changing anything.
Phase 0 experiment results are in [docs/FINDINGS.md](docs/FINDINGS.md).

Do not add features, checks or flags that aren't in the spec. If something in the spec is
technically impossible or wrong, stop and ask instead of improvising.

## Principles (these override everything else)

1. Silent when everything is in sync. Zero output, zero noise.
2. No false positives. If a check can't be sure, it stays silent. A warning that is still shown AFTER the user ran the suggested fix command is a release-blocking bug.
3. Never break the host app. pulled never throws into the host process, never calls process.exit in import mode (except strict mode, see section 4), and swallows its own errors. Set PULLED_DEBUG=1 to print internal errors and timings.
4. Never print secret values. Env checks print key names only.
5. No stored state and no git hooks. Every check compares a source file with the real thing on disk (or in the DB). No cache files, no .git writes, no dependency on git being installed.
6. Zero runtime dependencies. No network access except the optional migrations DB query.
7. Fast. All synchronous checks together must take < 25 ms on a project with ~1000 lockfile entries. Add a benchmark script that measures this.

## Working rules

- Follow the phase workflow in SPEC section 9; stop where it says STOP.
- Conventional commit messages, one commit per phase (Phase 2: one commit per check).
- Aim for ~1,200 lines of source; readability before line count.

## Dev notes

- **Real-DB tests**: any throwaway Postgres works (Homebrew Postgres 14 was used). From scratch:
  `initdb -D $D -U pulled --auth=trust` then
  `pg_ctl -D $D -o "-p 54329 -c unix_socket_directories='' -c listen_addresses=127.0.0.1" -l $D.log -w start`
  (`unix_socket_directories=''` because long temp paths exceed the socket path limit).
  Run: `PULLED_TEST_DATABASE_URL=postgresql://pulled@127.0.0.1:54329/postgres npm test`. Tests create and
  drop their own schema via `?options=-c search_path=...`. Stop with `pg_ctl -D $D -w stop`.
- **Phase 0 scratch projects** lived in the session scratchpad
  (`/private/tmp/claude-501/-Users-krishnaverma-Desktop-Projects-pulled/<session>/scratchpad`, likely gone after
  a reboot): npm1/npm2/ws (npm), pn1/pn9/pnh (pnpm), y1 (yarn v1), p6/p6m/p7/p7js/p6pn (Prisma 6/7, multi-file,
  pnpm), pgdata (the Postgres above). If gone, recreate per docs/FINDINGS.md.
- **Manual pull→fix check**: in a real project, simulate the pull (bump a dep in package.json / package-lock,
  edit schema.prisma, add a key to .env.example, add a migration folder), `npm run build`, then
  `node <repo>/dist/cli.js` (expect the warning, exit 1) → run the suggested fix (or `--fix`) → run again
  (expect silence, exit 0). Import mode: `node --import <repo>/dist/index.js -e ''`; add
  `PULLED_DEBUG=1` for timings and skip reasons. pnpm/yarn: `npx -y pnpm@10`, `npx -y yarn@1`.
- **Gotchas**
  - The user's shell is zsh: `$CMD install` doesn't word-split; wrap commands in shell functions.
  - The migrations query is dropped if the host exits immediately (sockets are unref'd). In manual tests keep
    the process alive: `-e 'setTimeout(()=>{}, 300)'`. Blackholed host for the timeout path: `10.255.255.1`.
  - `npx --no pulled --json` makes npm swallow `--json`; plain `npx pulled --json` is fine.
  - Running the e2e under `npx node@20.6.1` makes npm 11 print "does not support Node" warnings; e2e strips
    `npm warn` lines. CI uses each Node's bundled npm.
  - Biome excludes `**/*.md` so docs/SPEC.md isn't reformatted. vitest 4.1 / tsup 8.5 / TypeScript 5.9.3 are
    pinned on purpose (SPEC §10 decision 8, §11 decision 3).
  - Prisma rejects one-line models (`model A { id Int @id }`); fixture schemas must be multi-line for real
    `prisma generate`.
  - npm warns about esbuild's postinstall being blocked (allow-scripts); harmless.
