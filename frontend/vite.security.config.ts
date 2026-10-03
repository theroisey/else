// Test-only preview of the built artifact under the exact nginx header policy.
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const nginx = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8')
const headers: Record<string, string> = {}
for (const name of ['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy']) {
  const value = nginx.match(new RegExp(`add_header ${name} "([^"]+)" always;`))?.[1]
  if (!value) throw new Error('Declared runtime security header is missing.')
  headers[name] = value
}

export default defineConfig({
  plugins: [{
    name: 'synthetic-security-probe',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/_security-test/eval.js') return next()
        response.setHeader('Content-Type', 'application/javascript')
        response.end('window.syntheticEvalProbeLoaded = true; try { new Function("window.syntheticUnsafeEvalRan = true")() } catch {}')
      })
    },
  }],
  preview: {
    host: '127.0.0.1', strictPort: true, headers,
    proxy: {
      '^/health$': { target: 'http://127.0.0.1:8080' },
      '^/ready$': { target: 'http://127.0.0.1:8080' },
      '^/api/v1/': { target: 'http://127.0.0.1:8080' },
    },
  },
})
