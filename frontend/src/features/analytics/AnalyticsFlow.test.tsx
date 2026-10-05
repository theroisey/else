import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  clientID,
  otherID,
  record,
  client,
  identity,
  period,
  measured,
  empty,
} from './fixtures.test-data'
import type { View } from './models'

const analyticsIdentity: Session = {
  ...identity,
  user: {
    ...identity.user,
    permissions: [
      { permission: 'clients.view', scope: 'client', client_id: clientID },
      { permission: 'analytics.view', scope: 'client', client_id: clientID },
    ],
  },
}
const base = `/api/v1/clients/${clientID}`
const reportPath = `/app/clients/${clientID}/analytics/${record.id}`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup({
  session = analyticsIdentity,
  path = reportPath,
  read = () => json(measured()),
  mutate = () => Promise.resolve(json({ error: { code: 'conflict' } }, 409)),
}: {
  session?: Session
  path?: string
  read?: (url: string) => Response | Promise<Response>
  mutate?: (url: string, options: RequestInit) => Promise<Response>
} = {}) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  let current = session
  const cache = createQueryClient()
  const fetcher = vi.fn((url: string, options: RequestInit) => {
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: current }))
    if (options.method === 'POST') return mutate(url, options)
    if (url === base) return Promise.resolve(json({ data: client }))
    if (url === base + '/integrations/' + record.id)
      return Promise.resolve(json({ data: record }))
    if (url.startsWith(base + '/analytics')) return Promise.resolve(read(url))
    throw new Error('Unexpected synthetic request')
  })
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    cache,
    fetcher,
    setSession(next: Session) {
      current = next
      act(() =>
        cache.setQueryData(sessionKey, { session: current, expired: false }),
      )
    },
  }
}
async function choosePeriod() {
  const user = userEvent.setup()
  await screen.findByRole('button', { name: 'Load stored reports' })
  await user.type(screen.getByLabelText('Start date'), period.since)
  await user.type(screen.getByLabelText('End date'), period.until)
  await user.click(screen.getByRole('button', { name: 'Load stored reports' }))
}
it('reads measured reports with independent analytics access, exact totals and escaped landing text', async () => {
  const { fetcher } = setup()
  await choosePeriod()
  await screen.findByRole('table', { name: /Traffic acquisition/ })
  expect(screen.getAllByText('9,007,199,254,740,993').length).toBeGreaterThan(1)
  expect(screen.getAllByText('1.3333333333333333').length).toBeGreaterThan(1)
  expect(
    screen.getByText('Property timezone:', { exact: false }),
  ).toHaveTextContent('Europe/Istanbul')
  expect(
    screen.getByRole('img', { name: 'Daily active users bar chart' }),
  ).toBeInTheDocument()
  expect(screen.getByText('/synthetic')).not.toHaveAttribute('href')
  expect(
    screen.queryByRole('link', { name: 'Connection setup and sync' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(([url]) => url.includes('/integrations')),
  ).toBe(false)
  expect(
    fetcher.mock.calls.some(([, options]) => options.method === 'POST'),
  ).toBe(false)
})
it.each(['clients.view', 'analytics.view'])(
  'denies missing %s before reading private reports',
  async (permission) => {
    const { fetcher } = setup({
      session: {
        ...analyticsIdentity,
        user: {
          ...analyticsIdentity.user,
          permissions: analyticsIdentity.user.permissions.filter(
            (g) => g.permission !== permission,
          ),
        },
      },
    })
    await screen.findByRole('heading', { name: 'Access denied' })
    expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
  },
)
it.each(['empty', 'queued', 'failed', 'stale'] as const)(
  'shows honest %s status and never fills missing observations with zero',
  async (state) => {
    const value: View = state === 'stale' ? measured() : structuredClone(empty)
    if (state === 'stale') value.status.stale = true
    if (state === 'queued' || state === 'failed')
      value.status = {
        ...value.status,
        state,
        job_id: otherID,
        updated_at: client.updated_at,
        reason: state === 'failed' ? 'provider_unavailable' : null,
      }
    setup({ read: () => json(value) })
    await choosePeriod()
    await screen.findByLabelText('Synchronization status')
    if (state === 'stale') {
      expect(screen.getByText(/These reports are stale/)).toBeInTheDocument()
      expect(
        screen.getByRole('table', { name: /Daily trends/ }),
      ).toBeInTheDocument()
    } else {
      expect(
        screen.getByText(/No measured reports are available/),
      ).toBeInTheDocument()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(
        screen.getByText(/Last successful synchronization/),
      ).toHaveTextContent('Never')
    }
  },
)
it('hides cached measured values on failed reads and removes all data when grants change', async () => {
  let fail = false
  const context = setup({
    read: () =>
      fail
        ? json(
            {
              error: {
                code: 'internal_error',
                message: 'Synthetic private error',
              },
            },
            500,
          )
        : json(measured()),
  })
  await choosePeriod()
  await screen.findByRole('table', { name: /Daily trends/ })
  fail = true
  await act(async () => {
    await context.cache.invalidateQueries({ queryKey: ['analytics'] })
  })
  await screen.findByRole('alert')
  expect(screen.queryByText('9,007,199,254,740,993')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  fail = false
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('table', { name: /Daily trends/ })
  context.setSession({
    ...analyticsIdentity,
    user: { ...analyticsIdentity.user, permissions: [] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})
it('lists only GA4 safe metadata without integration view and follows the report route', async () => {
  setup({
    path: `/app/clients/${clientID}/analytics`,
    read: (url) =>
      url.includes(record.id)
        ? json(empty)
        : json({ data: [record], next_id: null }),
  })
  await screen.findByRole('table', { name: 'GA4 connections' })
  await userEvent.setup().click(screen.getByRole('link', { name: record.id }))
  await screen.findByRole('heading', { name: 'GA4 reports' })
  expect(screen.getByText(/Select a date range/)).toBeInTheDocument()
})
it('clears credentials immediately, sends one CSRF-protected setup request, and blocks uncertain retries', async () => {
  let resolve!: (response: Response) => void
  const context = setup({
    session: identity,
    path: `/app/clients/${clientID}/integrations/${record.id}`,
    mutate: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'GA4 setup and synchronization' })
  await user.type(screen.getByLabelText('Start date'), period.since)
  await user.type(screen.getByLabelText('End date'), period.until)
  const field = screen.getByLabelText('Service-account JSON key')
  await user.click(field)
  await user.paste('Synthetic private key fixture')
  await user.click(screen.getByRole('checkbox'))
  await user.click(
    screen.getByRole('button', { name: 'Replace key and queue sync' }),
  )
  expect(field).toHaveValue('')
  const writes = context.fetcher.mock.calls.filter(
    ([, options]) => options.method === 'POST',
  )
  expect(writes).toHaveLength(1)
  expect(writes[0]![0]).toBe(
    base + '/integrations/' + record.id + '/ga4/credentials',
  )
  expect(writes[0]![1].headers).toMatchObject({
    'X-CSRF-Token': 'a'.repeat(43),
  })
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({
    ...period,
    revision: record.revision,
    credential_json: 'Synthetic private key fixture',
  })
  expect(
    JSON.stringify(
      context.cache
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
    ),
  ).not.toContain('Synthetic private key')
  await act(async () =>
    resolve(
      json(
        {
          error: {
            code: 'unavailable',
            message: 'Synthetic private provider error',
          },
        },
        503,
      ),
    ),
  )
  await screen.findByRole('alert')
  expect(
    screen.getByRole('button', { name: 'Replace key and queue sync' }),
  ).toBeDisabled()
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  await user.click(screen.getByRole('button', { name: 'Reload connection' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Service-account JSON key')).toHaveValue(''),
  )
  expect(
    context.fetcher.mock.calls.filter(
      ([, options]) => options.method === 'POST',
    ),
  ).toHaveLength(1)
})
it('removes a populated secret form immediately when its grants change', async () => {
  const context = setup({
    session: identity,
    path: `/app/clients/${clientID}/integrations/${record.id}`,
  })
  await screen.findByLabelText('Service-account JSON key')
  const user = userEvent.setup()
  await user.click(screen.getByLabelText('Service-account JSON key'))
  await user.paste('Synthetic private key fixture')
  context.setSession({
    ...identity,
    user: { ...identity.user, permissions: [] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(
    screen.queryByLabelText('Service-account JSON key'),
  ).not.toBeInTheDocument()
  expect(
    context.fetcher.mock.calls.some(([, options]) => options.method === 'POST'),
  ).toBe(false)
})
it('reconciles a successful encrypted setup as queued without claiming a measured report', async () => {
  const context = setup({
    session: identity,
    path: `/app/clients/${clientID}/integrations/${record.id}`,
    mutate: async () =>
      json(
        {
          job_id: otherID,
          state: 'queued',
          connection_revision: '9007199254740995',
        },
        202,
      ),
  })
  const user = userEvent.setup()
  await screen.findByLabelText('Service-account JSON key')
  await user.type(screen.getByLabelText('Start date'), period.since)
  await user.type(screen.getByLabelText('End date'), period.until)
  await user.click(screen.getByLabelText('Service-account JSON key'))
  await user.paste('Synthetic private key fixture')
  await user.click(screen.getByRole('checkbox'))
  await user.click(
    screen.getByRole('button', { name: 'Replace key and queue sync' }),
  )
  await screen.findByText(/GA4 synchronization queued/)
  expect(screen.getByLabelText('Service-account JSON key')).toHaveValue('')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(
    context.fetcher.mock.calls.filter(
      ([, options]) => options.method === 'POST',
    ),
  ).toHaveLength(1)
})
it('shows last successful reports together with a failed refresh and paginates bounded tables', async () => {
  const value = measured()
  value.status.state = 'failed'
  value.status.reason = 'provider_unavailable'
  value.data!.landing.rows = Array.from({ length: 26 }, (_, i) => ({
    dimensions: ['/synthetic-' + String(i).padStart(2, '0')],
    metrics: ['1', '1', '1', '0'],
  }))
  setup({ read: () => json(value) })
  await choosePeriod()
  await screen.findByText('Synchronization failed')
  const table = screen.getByRole('table', { name: /Landing pages/ })
  expect(within(table).getAllByRole('row')).toHaveLength(26)
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Next landing pages' }))
  expect(within(table).getAllByRole('row')).toHaveLength(2)
  expect(screen.getByText('/synthetic-25')).toBeInTheDocument()
})
