import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30_000, reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // Authentication requests must never be retained in traces or video.
    trace: 'off', video: 'off', screenshot: 'off',
  },
})
