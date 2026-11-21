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
