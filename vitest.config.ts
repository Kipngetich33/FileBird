import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests only. Mirrors the aliases in electron.vite.config.ts; end-to-end
// checks against the running app live in scripts/smoke-test.mjs.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Container-backed tests run separately: npm run test:integration
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
    environment: 'node'
  }
})
