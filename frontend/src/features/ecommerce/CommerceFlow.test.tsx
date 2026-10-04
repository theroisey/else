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
import { clientID, otherID, record, client, identity, period, measured, empty } from './fixtures.test-data'
import type { View } from './models'

const commerceIdentity: Session = { ...identity, user: { ...identity.user, permissions: [
  { permission: 'clients.view', scope: 'client', client_id: clientID },
  { permission: 'analytics.view', scope: 'client', client_id: clientID },
] } }
const base = `/api/v1/clients/${clientID}`
const reportPath = `/app/clients/${clientID}/commerce/${record.id}`
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function setup({ session = commerceIdentity, path = reportPath, read = () => json(measured()), mutate = async () => json({ error: { code: 'conflict' } }, 409), connection = record }: {
  session?: Session; path?: string; read?: (url: string) => Response | Promise<Response>; mutate?: (url: string, options: RequestInit) => Promise<Response>; connection?: Connection
} = {}) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  let current = session
  const cache = createQueryClient()
  const fetcher = vi.fn((url: string, options: RequestInit) => {
    if (url === '/api/v1/auth/session') return Promise.resolve(json({ data: current }))
    if (options.method === 'POST') return mutate(url, options)
    if (url === base) return Promise.resolve(json({ data: client }))
    if (url === base + '/integrations/' + record.id) return Promise.resolve(json({ data: connection }))
    if (url.startsWith(base + '/integrations?')) return Promise.resolve(json({ data: [], page: { limit: 25, next_cursor: null } }))
    if (url.startsWith(base + '/commerce')) return Promise.resolve(read(url))
    throw new Error('Unexpected synthetic request')
  })
  vi.stubGlobal('fetch', fetcher)
  render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>)
  return { cache, fetcher, setSession(next: Session) { current = next; act(() => cache.setQueryData(sessionKey, { session: current, expired: false })) } }
}
async function fillPeriod() {
  const user = userEvent.setup()
  await screen.findByLabelText('Start date (UTC)')
  await user.type(screen.getByLabelText('Start date (UTC)'), period.start.slice(0, 10))
  await user.type(screen.getByLabelText('End date (UTC, exclusive)'), period.end.slice(0, 10))
  return user
}
async function choosePeriod() { const user = await fillPeriod(); await user.click(screen.getByRole('button', { name: 'Load stored reports' })); return user }
it('reads exact separate cohorts with independent analytics access and no integration or provider requests', async () => {
  const { fetcher } = setup()
  await choosePeriod()
  await screen.findByRole('table', { name: 'Original product lines' })
  expect(screen.getAllByText('USD 90,071,992,547,409.93').length).toBeGreaterThan(1)
  expect(screen.getAllByText('9007199254740993', { selector: 'td' })).toHaveLength(2)
  expect(screen.getByText('0 (none or unknown)')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Daily observed order totals and refunds' }).querySelectorAll('rect')).toHaveLength(2)
  expect(screen.getByLabelText('Synchronization status')).toHaveTextContent('Europe/Istanbul')
  expect(screen.queryByRole('link', { name: 'Connection setup and sync' })).not.toBeInTheDocument()
  expect(fetcher.mock.calls.some(([url]) => url.includes('/integrations'))).toBe(false)
  expect(fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
})
it.each(['clients.view', 'analytics.view'])('denies missing %s before reading commerce data', async permission => {
  const { fetcher } = setup({ session: { ...commerceIdentity, user: { ...commerceIdentity.user, permissions: commerceIdentity.user.permissions.filter(g => g.permission !== permission) } } })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
})
it.each(['empty', 'queued', 'failed', 'stale'] as const)('shows honest %s status without inventing observations', async state => {
  const value: View = state === 'stale' ? measured() : structuredClone(empty)
  if (state === 'stale') value.status.stale = true
  if (state === 'queued' || state === 'failed') value.status = { ...value.status, state, job_id: otherID, updated_at: client.updated_at, reason: state === 'failed' ? 'provider_unavailable' : null }
  setup({ read: () => json(value) })
  await choosePeriod()
  await screen.findByLabelText('Synchronization status')
  if (state === 'stale') expect(screen.getByText(/These reports are stale/)).toBeInTheDocument()
  else {
    expect(screen.getByText(/No measured reports are available/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Daily observed order totals and refunds' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Synchronization status')).toHaveTextContent('Never')
  }
})
it('hides cached values on read failures and removes reports when permissions change', async () => {
  let fail = false
  const context = setup({ read: () => fail ? json({ error: { code: 'internal_error', message: 'Synthetic private provider error' } }, 500) : json(measured()) })
  await choosePeriod()
  await screen.findByRole('table', { name: 'Original product lines' })
  fail = true
  await act(async () => { await context.cache.invalidateQueries({ queryKey: ['commerce'] }) })
  await screen.findByRole('alert')
  expect(screen.queryByText('USD 90,071,992,547,409.93')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  fail = false
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('table', { name: 'Original product lines' })
  context.setSession({ ...commerceIdentity, user: { ...commerceIdentity.user, permissions: [] } })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})
it('partitions selected currencies and periods without showing the previous report during loading', async () => {
  let resolve!: (response: Response) => void
  const context = setup({ read: url => new URL(url, 'https://app.example').searchParams.get('currency') === 'JPY' ? new Promise(r => { resolve = r }) : json(measured()) })
  const user = await choosePeriod()
  await screen.findByRole('table', { name: 'Original product lines' })
  await user.selectOptions(screen.getByLabelText('Report currency'), 'JPY')
  await user.click(screen.getByRole('button', { name: 'Load stored reports' }))
  expect(screen.queryByText('USD 90,071,992,547,409.93')).not.toBeInTheDocument()
  await act(async () => resolve(json(empty)))
  await screen.findByText(/No measured reports are available/)
  const reads = context.fetcher.mock.calls.filter(([url]) => url.startsWith(base + '/commerce'))
  expect(reads).toHaveLength(2)
  expect(new URL(reads[1]![0], 'https://app.example').searchParams.get('currency')).toBe('JPY')
})
it('lists safe WooCommerce metadata and follows reports without integration view', async () => {
  setup({ path: `/app/clients/${clientID}/commerce`, read: () => json({ data: [record], next_id: null }) })
  await screen.findByRole('table', { name: 'WooCommerce connections' })
  await userEvent.setup().click(screen.getByRole('link', { name: record.id }))
  await screen.findByRole('heading', { name: 'WooCommerce reports' })
  expect(screen.getByText(/Select a UTC period/)).toBeInTheDocument()
})
it('clears both keys before a single CSRF-protected request and blocks uncertain retries', async () => {
  let resolve!: (response: Response) => void
  const context = setup({ session: identity, path: `/app/clients/${clientID}/integrations/${record.id}`, mutate: () => new Promise(r => { resolve = r }) })
  const user = await fillPeriod()
  const key = screen.getByLabelText('Consumer key'), secret = screen.getByLabelText('Consumer secret')
  await user.type(key, 'ck_' + 'a'.repeat(40)); await user.type(secret, 'cs_' + 'b'.repeat(40))
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Replace Read key and queue sync' }))
  expect(key).toHaveValue(''); expect(secret).toHaveValue('')
  const writes = context.fetcher.mock.calls.filter(([, options]) => options.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(writes[0]![0]).toBe(base + '/integrations/' + record.id + '/woocommerce/credentials')
  expect(writes[0]![1].headers).toMatchObject({ 'X-CSRF-Token': 'a'.repeat(43) })
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({ ...period, revision: record.revision, consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) })
  expect(JSON.stringify(context.cache.getQueryCache().getAll().map(entry => entry.state.data))).not.toContain('cs_' + 'b'.repeat(40))
  await act(async () => resolve(json({ error: { code: 'unavailable', message: 'Synthetic private provider error' } }, 503)))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
  expect(screen.getByRole('button', { name: 'Replace Read key and queue sync' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Synchronize with saved key' })).toBeDisabled()
  expect(context.fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
})
it('clears malformed keys locally and removes populated secret fields on permission revocation', async () => {
  const context = setup({ session: identity, path: `/app/clients/${clientID}/integrations/${record.id}` })
  const user = await fillPeriod()
  const key = screen.getByLabelText('Consumer key'), secret = screen.getByLabelText('Consumer secret')
  await user.type(key, 'ck_invalid'); await user.type(secret, 'cs_invalid')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Replace Read key and queue sync' }))
  expect(key).toHaveValue(''); expect(secret).toHaveValue('')
  expect(screen.getByRole('alert')).toHaveTextContent('Both fields have been cleared')
  await user.type(key, 'ck_' + 'a'.repeat(40)); await user.type(secret, 'cs_' + 'b'.repeat(40))
  context.setSession({ ...identity, user: { ...identity.user, permissions: [] } })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(key).toHaveValue(''); expect(secret).toHaveValue('')
  expect(screen.queryByLabelText('Consumer key')).not.toBeInTheDocument()
  expect(context.fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
})
it('allows a manual saved-key retry for a previously configured pending connection without claiming success', async () => {
  const context = setup({ session: identity, connection: { ...record, state: 'pending' }, path: `/app/clients/${clientID}/integrations/${record.id}`, mutate: async () => json({ job_id: otherID, state: 'queued', connection_revision: record.revision }, 202) })
  const user = await fillPeriod()
  await user.click(screen.getByRole('button', { name: 'Synchronize with saved key' }))
  await screen.findByText(/WooCommerce synchronization queued/)
  expect(screen.getByText(/store access is not yet verified/)).toBeInTheDocument()
  const writes = context.fetcher.mock.calls.filter(([, options]) => options.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(writes[0]![0]).toBe(base + '/integrations/' + record.id + '/woocommerce/sync')
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({ revision: record.revision, ...period })
})
it('creates an explicitly authorized pending store and disables saved-key sync until a key is installed', async () => {
  const pending = { ...record, state: 'pending' as const, revision: '1' }
  const context = setup({ session: identity, connection: pending, path: `/app/clients/${clientID}/integrations`, mutate: async () => json({ data: pending }, 201) })
  const user = userEvent.setup()
  await screen.findByRole('heading', { name: 'Add WooCommerce store' })
  await user.type(screen.getByLabelText('WooCommerce HTTPS origin'), 'https://shop.example.com/wordpress')
  expect(screen.getByRole('button', { name: 'Add pending store' })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /permanently bind/ }))
  await user.click(screen.getByRole('button', { name: 'Add pending store' }))
  await screen.findByRole('heading', { name: 'WooCommerce setup and synchronization' })
  const writes = context.fetcher.mock.calls.filter(([, options]) => options.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]![1].body as string)).toEqual({ origin: 'https://shop.example.com/wordpress' })
  await fillPeriod()
  expect(screen.getByRole('button', { name: 'Synchronize with saved key' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save Read key and queue sync' })).toBeDisabled()
})
it('reconciles a successful key installation as queued while keeping both fields clear', async () => {
  const context = setup({ session: identity, path: `/app/clients/${clientID}/integrations/${record.id}`, mutate: async () => json({ job_id: otherID, state: 'queued', connection_revision: '9007199254740995' }, 202) })
  const user = await fillPeriod()
  await user.type(screen.getByLabelText('Consumer key'), 'ck_' + 'a'.repeat(40))
  await user.type(screen.getByLabelText('Consumer secret'), 'cs_' + 'b'.repeat(40))
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Replace Read key and queue sync' }))
  await screen.findByText(/WooCommerce synchronization queued/)
  expect(screen.getByLabelText('Consumer key')).toHaveValue('')
  expect(screen.getByLabelText('Consumer secret')).toHaveValue('')
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(context.fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
})
it('retains a successful snapshot alongside failed refresh status and paginates order rows', async () => {
  const value = measured()
  value.status.state = 'failed'; value.status.reason = 'provider_unavailable'
  value.data!.orders.orders = Array.from({ length: 26 }, (_, i) => ({ id: String(i + 1), status: 'pending', created_at: period.start, grand_total_minor: '1', lifetime_refund_minor: '0', remainder_minor: '1' }))
  value.data!.orders.grand_total_minor = '26'; value.data!.orders.lifetime_refund_minor = '0'; value.data!.orders.remainder_minor = '26'
  setup({ read: () => json(value) })
  const user = await choosePeriod()
  await screen.findByText('Synchronization failed')
  const table = screen.getByRole('table', { name: 'Order-created cohort' })
  expect(within(table).getAllByRole('row')).toHaveLength(26)
  await user.click(screen.getByRole('button', { name: 'Next order-created cohort' }))
  expect(within(table).getAllByRole('row')).toHaveLength(2)
  expect(within(table).getByText('26')).toBeInTheDocument()
})
