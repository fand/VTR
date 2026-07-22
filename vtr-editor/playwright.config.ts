import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Electron app binds fixed UDP ports; never run tests in parallel.
  workers: 1,
  reporter: 'list'
})
