import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entries: side-effect runner and programmatic API, ESM + CJS + .d.ts.
  {
    entry: { index: 'src/index.ts', api: 'src/api.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'node20',
    platform: 'node',
    clean: true,
    shims: true,
  },
  // CLI: ESM only, served as dist/cli.js (shebang is kept from the source).
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
  },
]);
