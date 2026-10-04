import { expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useNavigate } from 'react-router'
import type { NavigateFunction } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import { providerLabels } from './models'
import {
  clientID,
  otherID,
  connection,
  page,
  client,
  identity,
  cursor,
} from './fixtures.test-data'
const base = `/api/v1/clients/${clientID}`
const record = connection()
const route = `/app/clients/${clientID}/integrations`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
it.each(['meta_ads', 'ga4', 'woocommerce'] as const)(
  'shows stored %s provider on list/detail and honest manual attention',
  async (provider) => {
    const label = providerLabels[provider]
    const { fetcher } = setup({
      read: (url) => url.endsWith(record.id)
        ? json({ data: { ...record, provider, state: 'revocation_failed', revision: '9007199254740994' } })
        : json(page([{ ...record, provider, state: 'pending' }])),
    })
    const link = await screen.findByRole('link', { name: new RegExp(label) })
    expect(screen.getByText('Pending')).toBeInTheDocument()
    await userEvent.setup().click(link)
    await screen.findByRole('heading', { name: label })
    await screen.findByRole('heading', { name: 'Remote revocation requires manual action' })
    expect(screen.getByText(/Local credential use is disabled/).textContent).toContain(label)
    expect(screen.queryByRole('button', { name: 'Disable local use' })).not.toBeInTheDocument()
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false)
  },
)
function setup({
  session = identity,
  path = route,
  read = () => json(page([record])),
  mutate = () => Promise.resolve(json({ error: { code: 'conflict' } }, 409)),
  archived = false,
}: {
  session?: Session
  path?: string
  read?: (url: string) => Response | Promise<Response>
  mutate?: () => Promise<Response>
  archived?: boolean
} = {}) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  let current = session
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: current }))
    if (url === base)
      return Promise.resolve(
        json({
          data: {
            ...client,
            ...(archived
              ? { status: 'archived', archived_at: client.updated_at }
              : {}),
          },
        }),
      )
    if (url.endsWith('/disconnect') && init.method === 'POST') return mutate()
    if (url.startsWith(base + '/integrations') && init.method === 'GET')
      return Promise.resolve(read(url))
    throw new Error('Unexpected synthetic request: ' + url)
  })
  vi.stubGlobal('fetch', fetcher)
  const cache = createQueryClient()
  let navigate!: NavigateFunction
  function NavigationProbe() {
    navigate = useNavigate()
    return null
  }
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <NavigationProbe />
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    fetcher,
    cache,
    navigate: (to: string) => act(() => navigate(to)),
    setSession(next: Session, refresh = true) {
      current = next
      if (refresh)
        act(() =>
          cache.setQueryData(sessionKey, { session: current, expired: false }),
        )
    },
  }
}
it.each(['clients.view', 'integrations.view'])(
  'denies missing %s before private requests',
  async (permission) => {
    const { fetcher } = setup({
      session: {
        ...identity,
        user: {
          ...identity.user,
          permissions: identity.user.permissions.filter(
            (g) => g.permission !== permission,
          ),
        },
      },
    })
    await screen.findByRole('heading', { name: 'Access denied' })
    expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
  },
)
it('denies foreign scope and malformed routes before private reads', async () => {
  const { fetcher } = setup({
    session: {
      ...identity,
      user: {
        ...identity.user,
        permissions: identity.user.permissions.map((g) => ({
          ...g,
          client_id: otherID,
        })),
      },
    },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
})
it('shows loading then honest empty data with no producer actions', async () => {
  let resolve!: (r: Response) => void
  setup({
    read: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  await screen.findByText('Loading integrations…')
  await act(async () => resolve(json(page([]))))
  await screen.findByRole('heading', { name: 'No connections on this page' })
  expect(
    screen.queryByRole('button', { name: /Connect|Sync|Create/ }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})
it('pages forward/backward and refreshes first page with only safe metadata', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => connection(i + 1))
  const { fetcher } = setup({
    read: (url) =>
      json(
        url.includes('cursor=')
          ? page([connection(26)])
          : page(rows, cursor(rows.at(-1)!.id)),
      ),
  })
  const u = userEvent.setup()
  await screen.findByRole('table', { name: 'Integration connections' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText(connection(26).id)
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor='))).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Previous' }))
  await screen.findByText(record.id)
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText(connection(26).id)
  await u.click(screen.getByRole('button', { name: 'Refresh integrations' }))
  await screen.findByText(record.id)
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
})
it('confirms exactly once then keeps manual revocation attention visible', async () => {
  let current = record
  const { fetcher } = setup({
    path: route + '/' + record.id,
    read: () => json({ data: current }),
    mutate: async () => {
      current = {
        ...record,
        state: 'revocation_failed',
        revision: '9007199254740994',
      }
      return json({
        data: current,
        revocation: { status: 'unavailable', manual_action_required: true },
      })
    },
  })
  const u = userEvent.setup()
  await screen.findByRole('button', { name: 'Disable local use' })
  await u.click(screen.getByRole('button', { name: 'Disable local use' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveTextContent('Remote revocation is unavailable')
  await u.click(
    within(dialog).getByRole('button', { name: 'Confirm local disable' }),
  )
  await screen.findByRole('heading', {
    name: 'Remote revocation requires manual action',
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Disable local use' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.filter(([, options]) => options.method === 'POST'),
  ).toHaveLength(1)
  const options = fetcher.mock.calls.find(
    ([, options]) => options.method === 'POST',
  )![1]
  expect(JSON.parse(options.body as string)).toEqual({
    revision: record.revision,
    confirmed: true,
  })
})
it.each([
  'view-only',
  'archived',
  'disconnected',
  'revocation_failed',
] as const)('does not offer local disable for %s', async (scenario) => {
  setup({
    path: route + '/' + record.id,
    archived: scenario === 'archived',
    session:
      scenario === 'view-only'
        ? {
            ...identity,
            user: {
              ...identity.user,
              permissions: identity.user.permissions.filter(
                (g) => g.permission !== 'integrations.manage',
              ),
            },
          }
        : identity,
    read: () =>
      json({
        data: {
          ...record,
          state: ['disconnected', 'revocation_failed'].includes(scenario)
            ? scenario
            : 'connected',
        },
      }),
  })
  await screen.findByRole('heading', { name: 'Meta Ads' })
  expect(
    screen.queryByRole('button', { name: 'Disable local use' }),
  ).not.toBeInTheDocument()
})
it.each(['conflict', 'lost-response', 'malformed-response'])(
  'requires fresh data and renewed confirmation after %s',
  async (scenario) => {
    let current = record
    const { fetcher } = setup({
      path: route + '/' + record.id,
      read: () => json({ data: current }),
      mutate: async () => {
        if (scenario === 'conflict') {
          current = { ...record, revision: '9007199254740994' }
          return json(
            { error: { code: 'conflict', message: 'Synthetic private error' } },
            409,
          )
        }
        current = {
          ...record,
          state: 'revocation_failed',
          revision: '9007199254740994',
        }
        if (scenario === 'lost-response')
          throw new TypeError('Synthetic private network error')
        return json({
          data: current,
          revocation: { status: 'revoked', manual_action_required: false },
        })
      },
    })
    const u = userEvent.setup()
    await screen.findByRole('button', { name: 'Disable local use' })
    await u.click(screen.getByRole('button', { name: 'Disable local use' }))
    await u.click(screen.getByRole('button', { name: 'Confirm local disable' }))
    await screen.findByRole('alert')
    expect(
      screen.getByRole('button', { name: 'Confirm local disable' }),
    ).toBeDisabled()
    expect(screen.getByRole('alert')).not.toHaveTextContent('Synthetic private')
    expect(
      fetcher.mock.calls.filter(([, options]) => options.method === 'POST'),
    ).toHaveLength(1)
    await u.click(screen.getByRole('button', { name: 'Close and reload' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    if (scenario === 'conflict') {
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Disable local use' }),
        ).toBeEnabled(),
      )
      await u.click(screen.getByRole('button', { name: 'Disable local use' }))
      expect(screen.getByRole('dialog')).toBeVisible()
    } else
      await screen.findByRole('heading', {
        name: 'Remote revocation requires manual action',
      })
    expect(
      fetcher.mock.calls.filter(([, options]) => options.method === 'POST'),
    ).toHaveLength(1)
  },
)
it('hides cached records/actions on failed reads and supports safe read retry', async () => {
  let fail = false
  const { cache } = setup({
    path: route + '/' + record.id,
    read: () =>
      fail
        ? json(
            { error: { code: 'internal_error', message: 'Synthetic secret' } },
            500,
          )
        : json({ data: record }),
  })
  await screen.findByRole('button', { name: 'Disable local use' })
  fail = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['integrations'] })
  })
  await screen.findByRole('alert')
  expect(screen.queryByText(record.id)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Disable local use' }),
  ).not.toBeInTheDocument()
  fail = false
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('button', { name: 'Disable local use' })
})
it('removes old dialog and record immediately when grants change', async () => {
  const { setSession } = setup({
    path: route + '/' + record.id,
    read: () => json({ data: record }),
  })
  await screen.findByRole('button', { name: 'Disable local use' })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Disable local use' }))
  setSession({ ...identity, user: { ...identity.user, permissions: [] } })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText(record.id)).not.toBeInTheDocument()
})
it('refreshes session after server-side denial and removes stale records', async () => {
  let denied = false
  const context = setup({
    path: route + '/' + record.id,
    read: () =>
      denied
        ? json({ error: { code: 'not_found' } }, 404)
        : json({ data: record }),
  })
  await screen.findByRole('button', { name: 'Disable local use' })
  context.setSession(
    { ...identity, user: { ...identity.user, permissions: [] } },
    false,
  )
  denied = true
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Reload connection' }))
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText(record.id)).not.toBeInTheDocument()
})
it('rejects malformed detail routes without private reads', async () => {
  const { fetcher } = setup({ path: route + '/invalid' })
  await screen.findByRole('heading', { name: 'Integration not found' })
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
})
it('removes the previous connection and confirmation on a client-route change', async () => {
  const context = setup({
    path: route + '/' + record.id,
    read: () => json({ data: record }),
  })
  await screen.findByRole('button', { name: 'Disable local use' })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Disable local use' }))
  context.navigate(`/app/clients/${otherID}/integrations`)
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText(record.id)).not.toBeInTheDocument()
  expect(
    context.fetcher.mock.calls.some(([, options]) => options.method === 'POST'),
  ).toBe(false)
})
it('partitions actor replacement and suppresses the previous late read', async () => {
  let hold = false
  let resolve!: (r: Response) => void
  const context = setup({
    path: route + '/' + record.id,
    read: () =>
      hold
        ? new Promise((r) => {
            resolve = r
          })
        : json({ data: record }),
  })
  await screen.findByText('Connected (recorded)')
  hold = true
  let pending!: Promise<void>
  act(() => {
    pending = context.cache.invalidateQueries({ queryKey: ['integrations'] })
  })
  await screen.findByText('Loading connection…')
  hold = false
  context.setSession({ ...identity, user: { ...identity.user, id: otherID } })
  await screen.findByText('Connected (recorded)')
  await act(async () => {
    resolve(json({ data: { ...record, state: 'disconnected' } }))
    await pending
  })
  expect(screen.queryByText('Disconnected (recorded)')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Disable local use' }),
  ).toBeEnabled()
})
it('blocks closing or repeating confirmation while a mutation is pending', async () => {
  let resolve!: (r: Response) => void
  const context = setup({
    path: route + '/' + record.id,
    read: () => json({ data: record }),
    mutate: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  const u = userEvent.setup()
  await screen.findByRole('button', { name: 'Disable local use' })
  await u.click(screen.getByRole('button', { name: 'Disable local use' }))
  await u.click(screen.getByRole('button', { name: 'Confirm local disable' }))
  expect(
    screen.getByRole('button', { name: 'Confirm local disable' }),
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Keep local use' })).toBeDisabled()
  await u.keyboard('{Escape}')
  expect(screen.getByRole('dialog')).toBeVisible()
  await act(async () => resolve(json({ error: { code: 'conflict' } }, 409)))
  await screen.findByRole('alert')
  expect(
    context.fetcher.mock.calls.filter(
      ([, options]) => options.method === 'POST',
    ),
  ).toHaveLength(1)
})
