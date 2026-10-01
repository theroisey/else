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
    },
  },
  preview: { host: '127.0.0.1', strictPort: true, proxy: {} },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
