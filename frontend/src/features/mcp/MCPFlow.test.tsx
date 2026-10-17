import { afterEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { safeReturnTo } from '../shell/navigation'
const actor = '11111111-1111-4111-8111-111111111111'
const review = '22222222-2222-4222-8222-222222222222'
const expires = new Date(Date.now() + 600_000).toISOString()
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })
function setup(
  path: string,
  override: (path: string, init: RequestInit) => Response | undefined = () =>
    undefined,
) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((path: string, init: RequestInit = {}) => {
    const custom = override(path, init)
    if (custom) return Promise.resolve(custom)
    if (path === '/api/v1/auth/session')
      return Promise.resolve(
        json({
          data: {
            user: {
              id: actor,
              email: 'synthetic@example.com',
              display_name: 'Synthetic user',
              permissions: [],
            },
            session: { expires_at: expires },
          },
        }),
      )
    if (path === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (path.startsWith('/api/v1/notifications?'))
      return Promise.resolve(
        json({
          data: [],
          page: { limit: 25, next_cursor: null },
          unread_count: '0',
        }),
      )
    if (path === '/api/v1/mcp')
      return Promise.resolve(
        json({
          data: {
            enabled: true,
            revision: '1',
            endpoint: 'https://else.example/mcp',
            can_manage: false,
            scopes: ['clients:read'],
          },
        }),
      )
    if (path.startsWith('/api/v1/mcp/grants?'))
      return Promise.resolve(
        json({ data: [], page: { limit: 25, next_cursor: null } }),
      )
    return Promise.resolve(json({ error: { code: 'not_found' } }))
  })
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return fetcher
}
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('keeps owner controls unavailable to ordinary users and preserves safe OAuth return paths', async () => {
  const fetcher = setup('/app/mcp')
  await screen.findByText('No authorized applications.')
  expect(
    screen.queryByRole('button', { name: 'Enable MCP' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Register application' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(([p]) => p.startsWith('/api/v1/mcp/applications')),
  ).toBe(false)
  expect(safeReturnTo(`/app/mcp/authorize/${review}`)).toBe(
    `/app/mcp/authorize/${review}`,
  )
  expect(safeReturnTo(`/app/mcp/approvals/${review}`)).toBe(
    `/app/mcp/approvals/${review}`,
  )
  expect(safeReturnTo('/app/mcp/authorize/../../foreign')).toBe('/app')
  expect(safeReturnTo('https://foreign.example/app/mcp')).toBe('/app')
})
it('binds a browser decision to the displayed payload digest and never executes a tool from the review screen', async () => {
  const digest = 'a'.repeat(64)
  const fetcher = setup(`/app/mcp/approvals/${review}`, (path, init) => {
    if (path !== `/api/v1/mcp/approvals/${review}`) return undefined
    return init.method === 'POST'
      ? json({ data: { id: review, state: 'approved' } })
      : json({
          data: {
            id: review,
            tool_name: 'else_collections_record_payment',
            arguments: { input: { amount_minor: '60000', currency: 'USD' } },
            argument_digest: digest,
            command_id: actor,
            client_id: actor,
            state: 'pending',
            expires_at: expires,
            consumed_at: null,
            application_name: 'Synthetic assistant',
          },
        })
  })
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Approve exact change' }),
  )
  await screen.findByText(
    'Your decision is saved. Return to your assistant to continue.',
  )
  const post = fetcher.mock.calls.find(
    ([p, i]) => p === `/api/v1/mcp/approvals/${review}` && i?.method === 'POST',
  )
  const request = post?.[1]
  expect(request).toBeDefined()
  if (!request) throw new Error('Expected a browser approval request')
  expect(JSON.parse(request.body as string)).toEqual({
    approve: true,
    argument_digest: digest,
  })
  expect(new Headers(request.headers).get('X-CSRF-Token')).toBe('a'.repeat(43))
  expect(fetcher.mock.calls.some(([p]) => p === '/mcp')).toBe(false)
})
