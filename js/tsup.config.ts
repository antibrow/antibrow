import { defineConfig } from 'tsup'

const shared = {
  // No sourcemaps in the published package: a .map embeds the full original
  // source + comments, which would leak architecture/vendor details.
  sourcemap: false,
  external: ['playwright-core', '@modelcontextprotocol/sdk', 'ws'],
  // Shim import.meta.url / __dirname so the CJS build behaves like the ESM one.
  shims: true,
}

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    splitting: false,
    outDir: 'dist',
  },
  {
    ...shared,
    entry: ['src/cli.ts'],
    format: ['esm'],
    outDir: 'dist',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
])
