import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Integration tests against a real OpenSSH server in a container. Needs the
// Colima VM running (`colima start fly`); `npm test` stays container-free.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    // One container-backed file at a time keeps the 2 GB test VM comfortable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 240_000
  }
})
