import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Every spec drives real processes and UDP sockets; never run in parallel.
  workers: 1,
  // The CI runner is slow and shared, so a timing race there is not
  // reproducible locally. One retry keeps the run honest — a test that only
  // passes on the retry is reported as flaky, not as a pass.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list'
})
