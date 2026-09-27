import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Launch tests must never report to the real API; telemetry tests opt back in.
    env: { ANTIBROW_TELEMETRY: '0' },
  },
})
