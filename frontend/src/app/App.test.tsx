import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createQueryClient } from './query-client'

function renderApp(path = '/status') {
  const client = createQueryClient()
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>)
  return client
}

function respondingBackend(input: string | URL | Request) {
  return Promise.resolve(new Response(JSON.stringify(input === '/health' ? { status: 'ok' } : {
    error: { code: 'not_ready', message: 'Service is not ready.', request_id: 'demo-test-id' },
  }), { status: input === '/health' ? 200 : 503, headers: { 'Content-Type': 'application/json' } }))
}

describe('foundation application', () => {
  it('shows loading without fabricated availability or client metrics', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    renderApp()
    expect(screen.getByRole('heading', { name: 'Service status' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checking services' })).toBeDisabled()
    expect(screen.getAllByText('Checking')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Service checks' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
    expect(screen.getByText(/Client operations are not available yet/)).toBeInTheDocument()
  })

  it('shows real health and readiness independently, then supports keyboard retry', async () => {
    const fetchMock = vi.fn(respondingBackend)
    vi.stubGlobal('fetch', fetchMock)
    renderApp()
    expect(await screen.findByText('Available')).toBeInTheDocument()
    expect(await screen.findByText('Not ready')).toBeInTheDocument()
    const button = await screen.findByRole('button', { name: 'Check again' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const user = userEvent.setup()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Interface review' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveFocus()
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    await waitFor(() => expect(button).toBeEnabled())
  })

  it('shows safe errors and recovers after retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret-test-value'))
    vi.stubGlobal('fetch', fetchMock)
    renderApp()
    expect(await screen.findAllByText('Check failed')).toHaveLength(2)
    expect(screen.queryByText('secret-test-value')).not.toBeInTheDocument()
    fetchMock.mockImplementation(respondingBackend)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Available')).toBeInTheDocument()
    expect(await screen.findByText('Not ready')).toBeInTheDocument()
  })

  it('does not retain a successful badge when a later check fails', async () => {
    const fetchMock = vi.fn(respondingBackend)
    vi.stubGlobal('fetch', fetchMock)
    renderApp()
    await screen.findByText('Available')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled())
    fetchMock.mockRejectedValue(new Error('secret-test-value'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findAllByText('Check failed')).toHaveLength(2)
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
  })

  it('provides a working unknown-route fallback without probing services', async () => {
    const fetchMock = vi.fn(respondingBackend)
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/clients')
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Open service status' }))
    expect(await screen.findByRole('heading', { name: 'Service status' })).toBeInTheDocument()
    await screen.findByText('Available')
  })
})
