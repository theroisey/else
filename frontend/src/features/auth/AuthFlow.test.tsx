import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { AuthProvider } from './AuthProvider'
import { PermissionGuard } from './AuthGuard'
import { sessionKey } from './session'
import type { Session } from './session'

const identity: Session = {
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'browser.fixture@example.com', display_name: 'Browser Fixture', permissions: [{ permission: 'clients.view', scope: 'client', client_id: '22222222-2222-4222-8222-222222222222' }] },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const unauthorized = () => json(401, { error: { code: 'authentication_required' } })

function renderApp(path = '/app') {
  const client = createQueryClient()
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>)
  return client
}

afterEach(() => { document.cookie = 'else_csrf=; Max-Age=0; Path=/'; vi.useRealTimers() })

describe('cookie session UI', () => {
  it('hides protected content while checking and redirects unauthenticated deep links', async () => {
    let resolve: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done })))
    renderApp('/app/access')
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session')
    expect(screen.queryByRole('navigation', { name: 'Application' })).not.toBeInTheDocument()
    await act(async () => resolve(unauthorized()))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('validates inputs, clears passwords after attempts and uses safe generic failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValue(json(401, { error: { code: 'invalid_credentials', message: 'unsafe-test-secret' } }))
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/login')
    await screen.findByRole('heading', { name: 'Sign in' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await user.type(screen.getByLabelText('Email'), 'browser.fixture@example.com')
    await user.type(screen.getByLabelText('Password'), 'synthetic fixture password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.queryByText('unsafe-test-secret')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('signs in to the requested implemented page and shows only backend grants', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValue(json(200, { data: identity }))
    vi.stubGlobal('fetch', fetchMock)
    renderApp('/app/access')
    await screen.findByRole('heading', { name: 'Sign in' })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), identity.user.email)
    await user.type(screen.getByLabelText('Password'), 'synthetic fixture password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'My access' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('clients.view')
    expect(screen.queryByText('roles.manage')).not.toBeInTheDocument()
    const navigation = within(screen.getByRole('navigation', { name: 'Application' }))
    expect(navigation.getAllByRole('link').map((link) => link.textContent)).toEqual(['Workspace', 'My access', 'Service status'])
    expect(screen.queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument()
  })

  it('revokes through real transport semantics and removes cached private state', async () => {
    document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { data: identity })).mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = renderApp()
    await screen.findByRole('heading', { name: 'Welcome, Browser Fixture' })
    client.setQueryData(['private', 'fixture'], 'private fixture')
    const user = userEvent.setup()
    await user.click(screen.getByText('Browser Fixture', { selector: 'summary span' }))
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(client.getQueryData(['private', 'fixture'])).toBeUndefined()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/logout')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'a'.repeat(43) } })
    expect(screen.queryByRole('navigation', { name: 'Application' })).not.toBeInTheDocument()
  })

  it('keeps the signed-in state when logout fails verification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { data: identity })))
    renderApp()
    await screen.findByRole('heading', { name: 'Welcome, Browser Fixture' })
    const user = userEvent.setup()
    await user.click(screen.getByText('Browser Fixture', { selector: 'summary span' }))
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Request verification failed')
    expect(screen.getByRole('heading', { name: 'Welcome, Browser Fixture' })).toBeInTheDocument()
  })

  it('fails closed on service/malformed responses and recovers after retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: { user: { ...identity.user, permissions: [{ permission: 'roles.manage', scope: 'client' }] }, session: identity.session } }))
    vi.stubGlobal('fetch', fetchMock)
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Session check unavailable' })).toBeInTheDocument()
    expect(screen.queryByText(identity.user.email)).not.toBeInTheDocument()
    fetchMock.mockResolvedValue(json(200, { data: identity }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Welcome, Browser Fixture' })).toBeInTheDocument()
  })

  it('drops stale identity and grants on a later 401, then recovers through login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: identity }))
    vi.stubGlobal('fetch', fetchMock)
    const client = renderApp('/app/access')
    await screen.findByRole('table')
    fetchMock.mockResolvedValue(unauthorized())
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh access' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(client.getQueryData(sessionKey)).toMatchObject({ session: null, expired: true })
  })

  it('clears the UI at absolute expiry without requiring another request', async () => {
    const nearExpiry = { ...identity, session: { expires_at: new Date(Date.now() + 2_000).toISOString() } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { data: nearExpiry })))
    renderApp()
    await screen.findByRole('heading', { name: 'Welcome, Browser Fixture' })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(), { timeout: 3_000 })
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended')
  })

  it('hides cached private content when a later identity lookup fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: identity }))
    vi.stubGlobal('fetch', fetchMock)
    const client = renderApp('/app/access')
    await screen.findByRole('table')
    client.setQueryData(['private', 'fixture'], 'private fixture')
    fetchMock.mockRejectedValue(new Error('unsafe-test-detail'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh access' }))
    expect(await screen.findByRole('heading', { name: 'Session check unavailable' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(client.getQueryData(['private', 'fixture'])).toBeUndefined()
    expect(screen.queryByText('unsafe-test-detail')).not.toBeInTheDocument()
  })

  it('provides explicit empty access and no invented modules', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { data: { ...identity, user: { ...identity.user, permissions: [] } } })))
    renderApp('/app/access')
    expect(await screen.findByRole('heading', { name: 'No permissions assigned' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('blocks a direct permission-guarded view without its exact client grant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { data: identity })))
    render(<QueryClientProvider client={createQueryClient()}><AuthProvider><PermissionGuard required={{ permission: 'clients.view', scope: 'client', clientID: '33333333-3333-4333-8333-333333333333' }}><p>Private client fixture</p></PermissionGuard></AuthProvider></QueryClientProvider>)
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByText('Private client fixture')).not.toBeInTheDocument()
  })
})
