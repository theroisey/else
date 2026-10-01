import { mergeConfig } from 'vite'
import base from './vite.config.ts'

// Container-only networking; host development retains its loopback defaults.
export default mergeConfig(base, {
  server: {
    host: '0.0.0.0',
    proxy: {
      '^/health$': { target: 'http://backend:8080' },
      '^/ready$': { target: 'http://backend:8080' },
      '^/api/v1/': { target: 'http://backend:8080' },
    },
  },
})
