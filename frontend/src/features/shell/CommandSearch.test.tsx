import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { expect, it, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { createQueryClient } from '../../app/query-client'
import { CommandSearch } from './CommandSearch'

const clientID = '22222222-2222-4222-8222-222222222222'
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
it('opens from the keyboard, searches only after two characters and navigates authorized results', async () => {
  const fetcher = vi.fn((url: string) => Promise.resolve(json(url === '/api/v1/auth/session' ? { data: {
    user: { id: '11111111-1111-4111-8111-111111111111', display_name: 'Synthetic operator', email: 'operator@example.com', permissions: [{ permission: 'clients.view', scope: 'client', client_id: clientID }] },
    session: { expires_at: new Date(Date.now() + 3600000).toISOString() },
  }} : { data: [{ id: clientID, name: 'Ashford synthetic client', legal_name: '', status: 'active', revision: 1, tags: [], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', archived_at: null }], page: { limit: 25, next_cursor: null } })))
  vi.stubGlobal('fetch', fetcher)
  render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/app/access']}><AuthProvider><CommandSearch /><Routes><Route path="/app/access" element={<button>Original focus</button>} /><Route path="/app/clients/:id" element={<h1>Opened client dossier</h1>} /></Routes></AuthProvider></MemoryRouter></QueryClientProvider>)
  const user = userEvent.setup()
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  screen.getByRole('button', { name: 'Original focus' }).focus()
  await user.keyboard('{Control>}k{/Control}')
  expect(screen.getByRole('combobox')).toHaveFocus()
  expect(screen.queryByRole('option', { name: /Roles/ })).not.toBeInTheDocument()
  await user.type(screen.getByRole('combobox'), 'A')
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(fetcher).toHaveBeenCalledTimes(1)
  await user.type(screen.getByRole('combobox'), 'sh')
  await screen.findByRole('option', { name: /Ashford synthetic client/ })
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('q=Ash')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('button', { name: 'Original focus' })).toHaveFocus()
  await user.keyboard('{Meta>}k{/Meta}')
  await user.keyboard('{ArrowDown}{Enter}')
  expect(await screen.findByRole('heading', { name: 'Opened client dossier' })).toBeVisible()
})
