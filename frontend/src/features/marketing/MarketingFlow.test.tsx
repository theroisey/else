import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import type { Connection } from '../integrations/models'
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

const marketingIdentity: Session = {
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
const reportPath = `/app/clients/${clientID}/marketing/${record.id}`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup({
  session = marketingIdentity,
  path = reportPath,
  read = () => json(measured()),
  mutate = async () => json({ error: { code: 'conflict' } }, 409),
  connection = record,
}: {
  session?: Session
  path?: string
  read?: (url: string) => Response | Promise<Response>
  mutate?: (url: string, options: RequestInit) => Promise<Response>
  connection?: Connection
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
      return Promise.resolve(json({ data: connection }))
    if (url.startsWith(base + '/integrations?'))
      return Promise.resolve(
        json({ data: [], page: { limit: 25, next_cursor: null } }),
      )
    if (url.startsWith(base + '/marketing')) return Promise.resolve(read(url))
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
async function fillPeriod() {
  const user = userEvent.setup()
  await screen.findByLabelText('Start date')
  await user.type(screen.getByLabelText('Start date'), period.since)
  await user.type(screen.getByLabelText('End date'), period.until)
  return user
}
async function choosePeriod() {
  const user = await fillPeriod()
  await user.click(screen.getByRole('button', { name: 'Load stored reports' }))
  return user
}
it('shows exact measured spend and weighted totals with independent analytics permission', async () => {
  const { fetcher } = setup()
  await choosePeriod()
  await screen.findByRole('table', { name: 'Daily account observations' })
  expect(screen.getByText('1.980198%')).toBeInTheDocument()
  expect(
    screen
      .getByRole('img', { name: 'Daily observed Meta spend' })
      .querySelectorAll('rect'),
  ).toHaveLength(2)
  expect(
    screen.getByText(
      /Conversion attribution, revenue and ROAS are unavailable/,
    ),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Synchronization status')).toHaveTextContent(
    'Europe/Istanbul',
  )
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
  'denies missing %s before reading marketing data',
  async (permission) => {
    const { fetcher } = setup({
      session: {
        ...marketingIdentity,
        user: {
          ...marketingIdentity.user,
          permissions: marketingIdentity.user.permissions.filter(
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
  'shows honest %s without inventing observations',
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
    if (state === 'stale')
      expect(screen.getByText(/These reports are stale/)).toBeInTheDocument()
    else {
      expect(
        screen.getByText(/No measured reports are available/),
      ).toBeInTheDocument()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('img', { name: 'Daily observed Meta spend' }),
      ).not.toBeInTheDocument()
      expect(screen.getByLabelText('Synchronization status')).toHaveTextContent(
        'Never',
      )
    }
  },
)
it('hides cached values on failures and removes reports when permissions change', async () => {
  let fail = false
  const context = setup({
    read: () =>
      fail
        ? json(
            {
              error: {
                code: 'internal_error',
                message: 'Synthetic private token',
              },
            },
            500,
          )
        : json(measured()),
  })
  await choosePeriod()
  await screen.findByRole('table', { name: 'Daily account observations' })
  fail = true
  await act(async () => {
    await context.cache.invalidateQueries({ queryKey: ['marketing'] })
  })
  await screen.findByRole('alert')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  context.setSession({
    ...marketingIdentity,
    user: { ...marketingIdentity.user, permissions: [] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
})
it('partitions account date ranges and hides prior data during a changed-period request', async () => {
  let resolve!: (response: Response) => void
  const context = setup({
    read: (url) =>
      new URL(url, 'https://app.example').searchParams.get('until') ===
      period.since
        ? new Promise((r) => {
            resolve = r
          })
        : json(measured()),
  })
  const user = await choosePeriod()
  await screen.findByRole('table', { name: 'Daily account observations' })
  await user.clear(screen.getByLabelText('End date'))
  await user.type(screen.getByLabelText('End date'), period.since)
  await user.click(screen.getByRole('button', { name: 'Load stored reports' }))
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  await act(async () => resolve(json(empty)))
  await screen.findByText(/No measured reports are available/)
  expect(
    context.fetcher.mock.calls.filter(([url]) =>
      url.startsWith(base + '/marketing'),
    ),
  ).toHaveLength(2)
})
it('lists safe Meta metadata without integration view', async () => {
  setup({
    path: '/app/clients/' + clientID + '/marketing',
    read: () => json({ data: [record], next_id: null }),
  })
  await screen.findByRole('table', { name: 'Meta connections' })
  await userEvent.setup().click(screen.getByRole('link', { name: record.id }))
  await screen.findByRole('heading', { name: 'Meta Ads reports' })
})
it('clears a token before one CSRF-protected request and blocks uncertain retries', async () => {
  let resolve!: (response: Response) => void
  const context = setup({
    session: identity,
    path: '/app/clients/' + clientID + '/integrations/' + record.id,
    mutate: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  const user = await fillPeriod()
  const token = screen.getByLabelText('Meta user read token')
  await user.type(token, 'SyntheticReadTokenFixture123456')
  await user.click(screen.getByRole('checkbox'))
  await user.click(
    screen.getByRole('button', { name: 'Replace read token and queue sync' }),
  )
  expect(token).toHaveValue('')
  const writes = context.fetcher.mock.calls.filter(
    ([, options]) => options.method === 'POST',
  )
  expect(writes).toHaveLength(1)
  expect(writes[0]![0]).toBe(
    base + '/integrations/' + record.id + '/meta_ads/credentials',
  )
  expect(writes[0]![1].headers).toMatchObject({
    'X-CSRF-Token': 'a'.repeat(43),
  })
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({
    ...period,
    revision: record.revision,
    access_token: 'SyntheticReadTokenFixture123456',
  })
  expect(
    JSON.stringify(
      context.cache
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
    ),
  ).not.toContain('SyntheticReadTokenFixture123456')
  await act(async () =>
    resolve(
      json(
        { error: { code: 'unavailable', message: 'Synthetic private token' } },
        503,
      ),
    ),
  )
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  expect(
    screen.getByRole('button', { name: 'Replace read token and queue sync' }),
  ).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Synchronize with saved token' }),
  ).toBeDisabled()
  expect(
    context.fetcher.mock.calls.filter(
      ([, options]) => options.method === 'POST',
    ),
  ).toHaveLength(1)
})
it('clears invalid tokens locally and erases populated fields on permission revocation', async () => {
  const context = setup({
    session: identity,
    path: '/app/clients/' + clientID + '/integrations/' + record.id,
  })
  const user = await fillPeriod(),
    token = screen.getByLabelText('Meta user read token')
  await user.type(token, 'invalid token')
  await user.click(screen.getByRole('checkbox'))
  await user.click(
    screen.getByRole('button', { name: 'Replace read token and queue sync' }),
  )
  expect(token).toHaveValue('')
  expect(screen.getByRole('alert')).toHaveTextContent('field has been cleared')
  await user.type(token, 'SyntheticReadTokenFixture123456')
  context.setSession({
    ...identity,
    user: { ...identity.user, permissions: [] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(token).toHaveValue('')
  expect(
    context.fetcher.mock.calls.some(([, options]) => options.method === 'POST'),
  ).toBe(false)
})
it('permits explicit saved-token retry for a configured pending connection', async () => {
  const context = setup({
    session: identity,
    connection: { ...record, state: 'pending' },
    path: '/app/clients/' + clientID + '/integrations/' + record.id,
    mutate: async () =>
      json(
        {
          job_id: otherID,
          state: 'queued',
          connection_revision: record.revision,
        },
        202,
      ),
  })
  const user = await fillPeriod()
  await user.click(
    screen.getByRole('button', { name: 'Synchronize with saved token' }),
  )
  await screen.findByText(/Meta synchronization queued/)
  expect(
    screen.getByText(/account access is not yet verified/),
  ).toBeInTheDocument()
  const writes = context.fetcher.mock.calls.filter(
    ([, options]) => options.method === 'POST',
  )
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({
    revision: record.revision,
    ...period,
  })
})
it('creates an authorized immutable pending account and requires a first token', async () => {
  const pending = { ...record, state: 'pending' as const, revision: '1' }
  const context = setup({
    session: identity,
    connection: pending,
    path: '/app/clients/' + clientID + '/integrations',
    mutate: async () => json({ data: pending }, 201),
  })
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Add Meta ad account' })
  await user.type(screen.getByLabelText('Meta ad account ID'), '123456789')
  expect(
    screen.getByRole('button', { name: 'Add pending ad account' }),
  ).toBeDisabled()
  await user.click(
    screen.getByRole('checkbox', {
      name: /authorized to read this ad account/,
    }),
  )
  await user.click(
    screen.getByRole('button', { name: 'Add pending ad account' }),
  )
  await screen.findByRole('heading', { name: 'Meta setup and synchronization' })
  const writes = context.fetcher.mock.calls.filter(
    ([, options]) => options.method === 'POST',
  )
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({
    account_id: '123456789',
  })
  await fillPeriod()
  expect(
    screen.getByRole('button', { name: 'Synchronize with saved token' }),
  ).toBeDisabled()
})
it('preserves a large spend decimal and paginates observed days without inventing ratios', async () => {
  const value = measured(),
    r = value.data!.report
  r.days = [
    {
      date: period.since,
      spend_decimal: '9007199254740993.123456',
      impressions: '1',
      clicks: '1',
      ctr_percent: '100.000000',
      cpc_decimal: '9007199254740993.123456',
      cpm_decimal: '9007199254740993123.456000',
    },
  ]
  r.totals = { ...r.days[0]! }
  delete (r.totals as { date?: string }).date
  setup({ read: () => json(value) })
  await choosePeriod()
  await screen.findByRole('table', { name: 'Daily account observations' })
  expect(
    screen.getAllByText('USD 9,007,199,254,740,993.123456').length,
  ).toBeGreaterThan(1)
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
})
