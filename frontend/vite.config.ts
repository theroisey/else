import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '^/health$': { target: 'http://127.0.0.1:8080' },
      '^/ready$': { target: 'http://127.0.0.1:8080' },
      '^/api/v1/': { target: 'http://127.0.0.1:8080' },
    },
  },
  // Small font subsets must remain same-origin assets under the strict font-src policy.
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'runtime',
              test: /node_modules[\\/](?:react(?:-dom|-router|-i18next)?|scheduler|i18next|@tanstack|@fortawesome)[\\/]/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'workspace-core',
              test: /[\\/]src[\\/](?:app[\\/]|components[\\/]|i18n[\\/](?!locales[\\/](?:tr|ro|de|fr)(?:[\\/]|\.ts))|features[\\/](?:auth[\\/]|appearance[\\/]|clients[\\/]ClientRoute|shell[\\/](?:navigation|NavigationFocus))|services[\\/])/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  preview: { host: '127.0.0.1', strictPort: true, proxy: {} },
  test: {
    // Keep DOM interaction tests predictable on two-core CI/development hosts.
    maxWorkers: 2,
    // Reuse worker processes while retaining a separate VM/DOM for each file.
    pool: 'vmThreads',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
