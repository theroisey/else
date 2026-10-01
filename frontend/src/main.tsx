import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { createQueryClient } from './app/query-client'
import './app/styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing.')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
