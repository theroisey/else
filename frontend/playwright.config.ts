import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30_000, reporter: 'line',
  use: {
    baseURL: process.env.AUTH_TEST_ORIGIN ?? 'http://127.0.0.1:5173',
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {},
    // Authentication requests must never be retained in traces or video.
    trace: 'off', video: 'off', screenshot: 'off',
  },
})
