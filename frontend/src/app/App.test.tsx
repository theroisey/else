import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { App } from './App'
import { createQueryClient } from './query-client'

it.each(['/service-status', '/unregistered-page'])(
  'removes public service status and routes unavailable pages to the actual workspace: %s',
  async (path) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'authentication_required' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(
      screen.getByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
    await userEvent
      .setup()
      .click(screen.getByRole('link', { name: 'Open workspace' }))
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument()
    expect(
      fetcher.mock.calls.every(([url]) => url === '/api/v1/auth/session'),
    ).toBe(true)
    expect(
      screen.queryByRole('link', { name: 'Service status' }),
    ).not.toBeInTheDocument()
  },
)
