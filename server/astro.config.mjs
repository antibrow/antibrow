import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import node from '@astrojs/node'
import { fileURLToPath } from 'node:url'

const target = process.env.OEM_TARGET === 'cloudflare' ? 'cloudflare' : 'node'

// The Prisma client is emitted as raw .ts and carries its query compiler inline,
// so on the edge runtime it has to be bundled rather than externalized.
const prismaGenerated = fileURLToPath(
  new URL(`./node_modules/prisma-generated${target === 'cloudflare' ? '' : '-node'}/client.ts`, import.meta.url),
)

export default defineConfig({
  output: 'server',
  trailingSlash: 'never',
  // The SDK sends Bearer tokens, not cookies, and Node fetch sends no Origin.
  security: { checkOrigin: false },
  adapter: target === 'cloudflare' ? cloudflare({ platformProxy: { enabled: true } }) : node({ mode: 'standalone' }),
  server: { host: true, port: 4321 },
  vite: {
    resolve: { alias: { 'prisma-generated': prismaGenerated } },
    ssr: {
      external: target === 'cloudflare' ? ['pg', 'pg-cloudflare'] : [],
      noExternal: target === 'cloudflare' ? [/prisma-generated/, '@prisma/client', '@prisma/adapter-pg'] : [/prisma-generated/],
    },
    optimizeDeps: { exclude: ['pg', 'pg-cloudflare'] },
    build: { rollupOptions: { external: target === 'cloudflare' ? ['pg'] : [] } },
  },
})
