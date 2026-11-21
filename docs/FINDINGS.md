# Phase 0 findings

Run on 2026-11-21: macOS arm64, Node 26.5.0, npm 11.17.0, pnpm 9.x + 10.34.9, yarn 1.22.22
(pnpm and yarn run via `npx`, not installed globally), Prisma 6.19.3 and 7.10.1.
Experiments ran in a scratch folder outside the repo with throwaway prototype scripts.

## a) Package name

`npm view pulled` → 404. The name is free. Look-alike names npm would block
(`pull-ed`, `pull_ed`, `pull.ed`) are also free, so publishing as `pulled` should work.

## b) npm — `node_modules/.package-lock.json`

| Scenario | Result |
|---|---|
| Fresh `npm install` | Hidden lockfile written, same `lockfileVersion` (3). Every installed entry has the same version as in `package-lock.json`. |
| No-op `npm install` | Both files rewritten (mtimes updated). Content still matches. |
| `npm ci` | Hidden lockfile written, same as `npm install`. |
| `touch package-lock.json` | No difference: the comparison is content-based, so mtime doesn't matter. |
| Optional platform deps (esbuild) | `package-lock.json` has all 24 `@esbuild/*` entries with `optional: true` + `os`/`cpu`. Only `@esbuild/darwin-arm64` is in the hidden lockfile and on disk. The other 23 entries are "lockfile-only", and ignoring uninstalled `optional` entries makes the check silent. ✅ |
| Simulated pull (express 4.19.2 → 4.21.1, + zod) | Spec algorithm reports 12 stale (e.g. `body-parser 1.20.2 → 1.20.3`). After `npm install` → 0. ✅ |
| Dep added to package.json, lockfile not updated | Root-entry comparison flags it. After `npm install` → silent. ✅ |
| Workspaces | Workspace entries are `node_modules/a: { link: true }` (skipped) plus `packages/a: { version }`. Reading `packages/a/package.json` confirms the version, so the check stays silent. ✅ |
| Speed | Prototype took 0.5–1.1 ms on about 100 entries. The real-package.json fallback only runs for mismatches. |

### ⚠ False-positive trap found: dev deps omitted on purpose
With `npm install --omit=dev`, `omit=dev` in `.npmrc`, or `NODE_ENV=production` at install time,
entries marked `dev: true` are not installed and are missing from the hidden lockfile. The spec
algorithm reports them as `(not installed)`, and if `.npmrc` has `omit=dev`, running the suggested
`npm install` **does not clear it**. That breaks principle 2.

The hidden lockfile keeps the `dev: true` flag on entries it contains.
**Proposed rule:** if `package-lock.json` has `dev: true` entries but the hidden lockfile has none,
dev deps were left out on purpose, so ignore uninstalled `dev: true` entries. Also treat
`devOptional: true` like `optional: true`. Worst case is a false negative, never a false positive.

## c) pnpm and yarn v1

### pnpm: compare `pnpm-lock.yaml` with `node_modules/.pnpm/lock.yaml` ✅
pnpm keeps a copy of the lockfile it installed from at `node_modules/.pnpm/lock.yaml`
(pnpm 9 and 10, and also with `node-linker=hoisted`). For a normal install it is **byte-identical**
to `pnpm-lock.yaml`.

| Scenario | Copy matches? |
|---|---|
| Fresh install / no-op install / `touch` + install | same |
| Checkout older lockfile → before / after `pnpm install` | differs / same ✅ |
| Pull newer lockfile → before / after `pnpm install` | differs / same ✅ |
| Lockfile written by pnpm 9, installed by pnpm 10 | same |
| CRLF `pnpm-lock.yaml` (Windows `autocrlf`) | **differs byte-wise, even after install**: pnpm writes the copy with LF. Fix: strip `\r` before comparing → same ✅ |
| `pnpm install --prod` (dev deps in lockfile) | **differs, and keeps differing** after a plain `pnpm install` if `production=true` is configured. The copy leaves out the importers/packages that weren't installed. |

**Method:** compare the two files with `\r` removed. If they differ and
`node_modules/.modules.yaml` → `included` shows `devDependencies: false` or `optionalDependencies: false`,
stay silent (we can't tell a filtered install from a stale one). `.modules.yaml` is JSON in pnpm 10
and YAML in pnpm 9, so read `included` with a small regex, not a parser.
Comparing mtimes is not needed (and is weaker: a re-checkout changes mtime but not content).

Limitation: without a YAML parser we can't cheaply list "express 4.19.2 → 4.21.1" examples. The issue
would be a single line: "pnpm-lock.yaml changed since the last install". Examples are only specified
for npm, so this fits the spec.

### yarn v1: compare `yarn.lock` with `node_modules/.yarn-integrity` → `lockfileEntries` ✅
`.yarn-integrity` is JSON with `lockfileEntries: { "<pattern>": "<resolved url>" }`, one key per
pattern in `yarn.lock`, including all optional platform entries. Parsing yarn.lock v1 (header line →
patterns, `  resolved "<url>"` line) gives the same map.

| Scenario | Result |
|---|---|
| Fresh / no-op / `touch` + `yarn` | 0 diffs |
| Pull newer lockfile → before / after `yarn` | 22 diffs / 0 ✅ |
| Checkout older lockfile → before / after `yarn` | 22 diffs / 0 ✅ |
| CRLF `yarn.lock` | 0 diffs (parser strips `\r`) ✅ |
| `yarn install --production` | 0 diffs (lockfileEntries still holds the full lock; `flags: ["production"]`) ✅ |

Examples can be derived from differing keys (e.g. `express@4.21.1`). Edge case for implementation:
lock entries without a `resolved` field (`file:`/`link:` deps) are skipped on both sides. Yarn berry
is detected by `__metadata:` in yarn.lock (v1 has `# yarn lockfile v1`) and skipped as specified.

## d) Prisma

### Prisma 6 (`prisma-client-js`)
- Output is `node_modules/.prisma/client/`, which includes **`schema.prisma`, a copy of the schema**
  (plus `inlineSchema` / `inlineSchemaHash` in `index.js`).
- The copy is **not byte-identical**: Prisma runs `prisma format` on it (re-aligns `=`, normalizes
  indentation, adds blank lines between blocks, LF line endings). After a comment-only edit +
  `prisma generate`, a byte comparison still showed a difference. **Byte comparison would be a
  lasting false positive.**
- **Whitespace-insensitive comparison** (remove all `\s`) matched after generate in every case,
  including a deliberately messy CRLF/tab/odd-spacing schema with comments, `///` docs, `@@map`, enums
  and relations. Edits that change content (a new model, even a new comment) are detected.
  A whitespace-only edit is correctly treated as in sync (it doesn't need a regenerate).
- `inlineSchemaHash` is not a sha256 of the schema or of the copy. Its algorithm is undocumented, so don't use it.
- **Multi-file schemas** (`prisma/schema/*.prisma`, including subfolders): the copy concatenates all
  files in an order that is **not alphabetical** (observed: `Zeta`, `alpha`, `main`, `sub/beta`).
  Use an order-free comparison: whitespace-stripped copy length == sum of stripped file lengths, AND
  each stripped file occurs in the stripped copy. Passed the add-file → stale → generate → in-sync cycle.
- `prisma generate` rewrites output files every time (mtime updates even with no schema change), so the
  mtime fallback would also clear after a fix, but it isn't needed.

### Prisma 7 (`prisma-client` with `output`)
- Output is plain TS source at `<output>/` (`client.ts`, `models/*.ts`, `internal/class.ts`, …). There is
  **no schema copy file and no hash**, but `internal/class.ts` contains `"inlineSchema": "<JSON string>"`.
- Extract it with a regex for a JSON string literal, then `JSON.parse`. The same whitespace-insensitive,
  order-free comparison passed: in sync → edit → stale → generate → in sync, messy CRLF schema, and multi-file.
- Generator option `generatedFileExtension` changes the file to `class.mts` / `class.cts`, so look for
  `internal/class.{ts,mts,cts,js,mjs,cjs}`. File is about 10 KB, so reading it is cheap.
- Multi-file: `output` is resolved relative to **the .prisma file that contains the generator block**.
- Prisma 7 still accepts `prisma-client-js` and writes the same `node_modules/.prisma/client/schema.prisma` copy.
- Prisma 7 removes `url` from the schema `datasource` (it lives in `prisma.config.ts`).

### ⚠ Spec issue: `prisma-client-js` output location under pnpm
With pnpm's default isolated linker, `node_modules/.prisma/client` **does not exist** at the root. The
client is generated next to the real `@prisma/client`:
`node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3/node_modules/.prisma/client`.
"Resolve via the root node_modules" would report "Prisma client was never generated" forever, even after
`pnpm prisma generate`. **Proposed:** `realpath(<root>/node_modules/@prisma/client)/../../.prisma/client`.
For npm/yarn this resolves to the same `node_modules/.prisma/client`.

## Decisions / questions for you

1. **npm `omit=dev`**: OK to add the rule "lockfile has dev entries but hidden lockfile has none →
   ignore uninstalled dev entries" (and treat `devOptional` as optional)?
2. **pnpm**: lockfile-copy comparison with `\r` stripped, silent when `.modules.yaml` shows a filtered
   install, single-line issue with no examples. OK?
3. **yarn v1**: `.yarn-integrity` `lockfileEntries` comparison. OK?
4. **Prisma staleness**: whitespace-insensitive, order-free comparison against the Prisma 6
   `schema.prisma` copy / Prisma 7 `inlineSchema`. No mtime fallback. OK?
5. **Prisma output under pnpm**: resolve via realpath of `@prisma/client` as above. OK?
6. **Prisma 7 + migrations**: the DB URL env name is no longer in the schema. Default to `DATABASE_URL`
   only (as specified), or also extract `env("X")` / `process.env.X` from prisma.config.* with the same
   conservative regex?
7. **Small inconsistencies in the spec text**: issue title "schema.prisma changed since the client was
   generated" (section 5) vs "Prisma client is older than schema.prisma" (section 6 example), and env fix
   "add them to .env — see .env.example" vs "add them to .env (see .env.example)". Which wording wins?
8. **CI on Node 18**: vitest 4 requires Node ≥ 20. To run tests on Node 18 as specified, pin vitest 3.x
   (or test the built package on 18 and run vitest on 20/22 only).
