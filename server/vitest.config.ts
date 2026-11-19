import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Vitest does not read astro.config.mjs; keep this alias in sync with it.
const prismaGenerated = fileURLToPath(new URL('./node_modules/prisma-generated-node/client.ts', import.meta.url))

export default defineConfig({
  resolve: { alias: { 'prisma-generated': prismaGenerated } },
  // DB tests share one database and reset it per test.
  test: { fileParallelism: false },
})
