import { it, expect, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import { collection } from '../billing/fixtures.test-data'
import {
  sheet,
  version,
  profile,
  calculation,
  snapshot,
  session,
  clientID,
  sheetID,
  versionID,
  nextID,
  withoutCosts,
} from './fixtures.test-data'
import { pricingPermissions } from './hooks'
import { safeReturnTo } from '../shell/navigation'
import { utcToday } from './exact'
const base = `/api/v1/clients/${clientID}/pricing`,
  path = `/app/clients/${clientID}/pricing`,
  detail = path + '/' + sheetID,
  billing = `/api/v1/clients/${clientID}/billing`,
  billingPath = `/app/clients/${clientID}/billing/${collection.id}`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const page = (data: unknown[]) => ({
  data,
  page: { limit: 25, next_cursor: null },
})
type Override = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response> | undefined
function setup(
  route = detail,
  identity: Session = session,
  override: Override = () => undefined,
) {
  const cache = createQueryClient(),
    manage = identity.user.permissions.some(
      (g) => g.permission === 'pricing.manage',
    ),
    current = structuredClone(sheet),
    financial = {
      ...collection,
      amount_minor: '125',
      outstanding_minor: '125',
      revision: '1',
    }
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: identity }))
    if (init.method === 'GET') {
      if (url.startsWith(base + '?'))
        return Promise.resolve(
          json(
            page([
              {
                ...current,
                latest_version: manage
                  ? current.latest_version
                  : withoutCosts(current.latest_version),
              },
            ]),
          ),
        )
      if (url === base + '/' + sheetID)
        return Promise.resolve(
          json({
            data: {
              ...current,
              latest_version: manage
                ? current.latest_version
                : withoutCosts(current.latest_version),
            },
          }),
        )
      if (url.includes('/versions?'))
        return Promise.resolve(
          json(
            page([
              manage
                ? current.latest_version
                : withoutCosts(current.latest_version),
            ]),
          ),
        )
      if (url.includes('/versions/'))
        return Promise.resolve(
          json({ data: manage ? version : withoutCosts(version) }),
        )
      if (url === billing + '/' + collection.id)
        return Promise.resolve(json({ data: financial }))
      if (url.endsWith('/pricing-snapshot'))
        return Promise.resolve(json({ data: snapshot }))
      if (url.includes('/payments?')) return Promise.resolve(json(page([])))
      if (url.endsWith('/currencies'))
        return Promise.resolve(
          json({
            data: [
              { code: 'USD', exponent: 2 },
              { code: 'EUR', exponent: 2 },
              { code: 'GBP', exponent: 2 },
              { code: 'TRY', exponent: 2 },
              { code: 'JPY', exponent: 0 },
              { code: 'KWD', exponent: 3 },
            ],
          }),
        )
      throw new Error('Unexpected private read')
    }
    if (url.endsWith('/preview'))
      return Promise.resolve(json({ data: calculation }))
    if (url.endsWith('/collections'))
      return Promise.resolve(
        json({ data: { id: collection.id, revision: '1', replayed: false } }),
      )
    if (url === base || url.endsWith('/versions')) {
      const input = JSON.parse(init.body as string)
      const revision = String(BigInt(input.expected_revision ?? '0') + 1n)
      current.revision = revision
      current.latest_version = { ...version, ...input, id: nextID, revision }
      delete (current.latest_version as unknown as Record<string, unknown>)
        .expected_revision
      return Promise.resolve(
        json({ data: { id: sheetID, version_id: nextID, revision } }),
      )
    }
    throw new Error('Unexpected write')
  })
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { cache, fetcher, current }
}
const grants = (keys: string[]): Session => ({
  ...session,
  user: {
    ...session.user,
    permissions: keys.map((permission) => ({
      permission,
      scope: 'client',
      client_id: clientID,
    })),
  },
})
const posts = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([, init]) => init.method === 'POST')
async function fill() {
  await screen.findByLabelText('Agreement title')
  fireEvent.change(screen.getByLabelText('Agreement title'), {
    target: { value: profile.title },
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Currency' }), {
    target: { value: 'USD' },
  })
  for (const [label, value] of [
    ['Line 1 description', 'Synthetic recurring service'],
    ['Line 1 quantity', '1.5'],
    ['Line 1 unit price', '1.01'],
    ['Line 1 discount (%)', '25'],
    ['Line 1 tax (%)', '10'],
    ['Line 1 internal unit cost', '0.07'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } })
}
it('keeps loading and failed agreement reads explicit and retries to a real empty state', async () => {
  let respond!: (r: Response) => void
  let reads = 0
  const { fetcher } = setup(path, grants(['pricing.view']), (u) => {
    if (!u.startsWith(base + '?')) return undefined
    reads++
    return reads === 1
      ? new Promise<Response>((resolve) => {
          respond = resolve
        })
      : json(page([]))
  })
  expect(await screen.findByText('Loading pricing agreements…')).toBeVisible()
  await act(async () => {
    respond(json({ error: { code: 'internal_error' } }, 500))
  })
  expect(await screen.findByRole('alert')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByRole('heading', { name: 'No pricing agreements' }),
  ).toBeVisible()
  expect(reads).toBe(2)
  expect(posts(fetcher)).toHaveLength(0)
})
it('retains archived agreement history while disabling append and new collection writes', async () => {
  const identity = grants([
    ...session.user.permissions.map((g) => g.permission),
    'clients.view',
  ])
  const { fetcher } = setup(detail, identity, (u) =>
    u === `/api/v1/clients/${clientID}`
      ? json({
          data: {
            id: clientID,
            name: 'Synthetic archived client',
            legal_name: '',
            status: 'archived',
            revision: 1,
            tags: [],
            website: '',
            notes: '',
            contacts: [],
            created_at: version.created_at,
            updated_at: version.created_at,
            archived_at: version.created_at,
          },
        })
      : undefined,
  )
  expect(
    await screen.findByRole('link', { name: 'Version 1 · ' + profile.title }),
  ).toBeVisible()
  expect(
    screen.queryByRole('link', { name: 'Create new version' }),
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Create collection from version' }),
  ).toBeDisabled()
  expect(posts(fetcher)).toHaveLength(0)
})
it('shows real history with view-only grants and no metadata or cost reads', async () => {
  const { fetcher } = setup(detail, grants(['pricing.view']))
  expect(
    await screen.findByRole('heading', { name: profile.title }),
  ).toBeVisible()
  expect(
    await screen.findByRole('link', { name: 'Version 1 · ' + profile.title }),
  ).toBeVisible()
  expect(screen.queryByText(/Internal unit cost/)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Create new version' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Create collection from version' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(
      ([u]) =>
        u.startsWith(base) ||
        u === '/api/v1/auth/session' ||
        u === '/api/v1/auth/preferences',
    ),
  ).toBe(true)
})
it.each(
  [[], ['pricing.manage'], ['pricing.view', 'billing.manage']].map((keys) => ({
    keys,
  })),
)('fails closed for denied grant combination %j', async ({ keys }) => {
  const { fetcher } = setup(path + '/new', grants(keys))
  expect(
    await screen.findByRole('heading', { name: 'Access denied' }),
  ).toBeVisible()
  expect(posts(fetcher)).toHaveLength(0)
  expect(fetcher.mock.calls.some(([u]) => u.startsWith(base))).toBe(false)
})
it('requires an exact current server preview before creation and invalidates it on change', async () => {
  const { fetcher } = setup(path + '/new')
  await fill()
  expect(
    screen.getByRole('button', { name: 'Save pricing agreement' }),
  ).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Preview pricing' }))
  expect(await screen.findByText(/Preview matches/)).toBeVisible()
  const request = JSON.parse(posts(fetcher)[0]![1].body)
  expect(request.lines[0]).toEqual(profile.lines[0])
  expect(
    screen.getByRole('button', { name: 'Save pricing agreement' }),
  ).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Agreement title'), {
    target: { value: 'Changed draft' },
  })
  expect(
    screen.getByRole('button', { name: 'Save pricing agreement' }),
  ).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Agreement title'), {
    target: { value: profile.title },
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Save pricing agreement' }),
  )
  expect(
    await screen.findByRole('heading', {
      name: 'Pricing agreement',
    }),
  ).toBeVisible()
  expect(posts(fetcher).filter(([u]) => u === base)).toHaveLength(1)
})
it('rejects excess quantity precision before any preview or write', async () => {
  const { fetcher } = setup(path + '/new')
  await fill()
  fireEvent.change(screen.getByLabelText('Line 1 quantity'), {
    target: { value: '0.0000001' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Preview pricing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('6 decimal')
  expect(posts(fetcher)).toHaveLength(0)
})
it('appends complete pricing under its original revision, never changing old lines', async () => {
  const { fetcher } = setup(detail + '/new-version')
  await screen.findByLabelText('Agreement title')
  expect(screen.getByRole('combobox', { name: 'Currency' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Preview pricing' }))
  expect(await screen.findByText(/Preview matches/)).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Save new version' }),
  )
  await screen.findByRole('heading', { name: 'Pricing agreement' })
  const body = JSON.parse(
    posts(fetcher).find(([u]) => u.endsWith('/versions'))![1].body,
  )
  expect(body.expected_revision).toBe('1')
  expect(body.lines[0].unit_price_minor).toBe('101')
  expect(version.revision).toBe('1')
})
it('freezes a stale or unknown append and requires reviewing current history', async () => {
  const { fetcher } = setup(detail + '/new-version', session, (u, i) =>
    u.endsWith('/versions') && i.method === 'POST'
      ? json({ error: { code: 'conflict' } }, 409)
      : undefined,
  )
  await screen.findByLabelText('Agreement title')
  await userEvent.click(screen.getByRole('button', { name: 'Preview pricing' }))
  await screen.findByText(/Preview matches/)
  await userEvent.click(
    screen.getByRole('button', { name: 'Save new version' }),
  )
  expect(await screen.findByText(/No new version is confirmed/)).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Save new version' }),
  ).toBeDisabled()
  expect(posts(fetcher).filter(([u]) => u.endsWith('/versions'))).toHaveLength(
    1,
  )
})
it('adds, reorders and removes draft lines without any write', async () => {
  const { fetcher } = setup(path + '/new')
  await fill()
  await userEvent.click(screen.getByRole('button', { name: 'Add line' }))
  fireEvent.change(screen.getByLabelText('Line 2 description'), {
    target: { value: 'Synthetic second' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Move line 2 up' }))
  expect(screen.getByLabelText('Line 1 description')).toHaveValue(
    'Synthetic second',
  )
  await userEvent.click(screen.getByRole('button', { name: 'Remove line 1' }))
  expect(screen.getByLabelText('Line 1 description')).toHaveValue(
    'Synthetic recurring service',
  )
  expect(posts(fetcher)).toHaveLength(0)
})
async function copy() {
  await screen.findByRole('heading', {
    name: 'Create collection from this version',
  })
  await userEvent.click(
    screen.getByLabelText('I confirm this fixed collection amount.'),
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Create collection from version' }),
  )
}
it('replays only an identical original copy command after a lost response and in-app Back', async () => {
  let calls = 0
  const { fetcher } = setup(detail, session, (u, i) =>
    u.endsWith('/collections') && i.method === 'POST'
      ? ++calls === 1
        ? Promise.reject(new TypeError('Synthetic lost response'))
        : json({ data: { id: collection.id, revision: '4', replayed: true } })
      : undefined,
  )
  await copy()
  let dialog = await screen.findByRole('dialog', {
    name: 'Confirming collection',
  })
  expect(dialog).toHaveTextContent('unconfirmed')
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
  await userEvent.keyboard('{Escape}')
  expect(dialog).toBeVisible()
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Retry original collection' }),
  )
  dialog = await screen.findByRole('dialog', { name: 'Collection confirmed' })
  expect(dialog).toHaveTextContent('No duplicate')
  const attempts = posts(fetcher).filter(([u]) => u.endsWith('/collections'))
  expect(attempts).toHaveLength(2)
  expect(attempts[0]![1].body).toBe(attempts[1]![1].body)
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Open collection' }),
  )
  expect(
    await screen.findByRole('heading', { name: 'Copied pricing terms' }),
  ).toBeVisible()
})
it('keeps an unknown retry conflict unresolved and prevents a replacement', async () => {
  let calls = 0
  const { fetcher } = setup(detail, session, (u, i) =>
    u.endsWith('/collections') && i.method === 'POST'
      ? ++calls === 1
        ? Promise.reject(new TypeError('Synthetic lost response'))
        : json({ error: { code: 'conflict' } }, 409)
      : undefined,
  )
  await copy()
  const dialog = await screen.findByRole('dialog', {
    name: 'Confirming collection',
  })
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Retry original collection' }),
  )
  expect(
    await within(dialog).findByText(/Do not create a replacement/),
  ).toBeVisible()
  expect(
    within(dialog).queryByRole('button', { name: 'Review current pricing' }),
  ).not.toBeInTheDocument()
  expect(
    posts(fetcher).filter(([u]) => u.endsWith('/collections')),
  ).toHaveLength(2)
})
it('clears private costs and recovery when grants change', async () => {
  const { cache } = setup()
  await screen.findByText(/Internal aggregate cost/)
  await act(async () =>
    cache.setQueryData(sessionKey, {
      session: grants(['pricing.view']),
      expired: false,
    }),
  )
  await waitFor(() =>
    expect(
      screen.queryByText(/Internal aggregate cost/),
    ).not.toBeInTheDocument(),
  )
  expect(
    screen.queryByRole('link', { name: 'Create new version' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Create collection from version' }),
  ).not.toBeInTheDocument()
})
it('retains billing-only terms and makes copied unpaid amounts read only', async () => {
  const { fetcher } = setup(
    billingPath + '/edit',
    grants(['billing.view', 'billing.update']),
  )
  expect(await screen.findByLabelText('Collection amount')).toHaveAttribute(
    'readonly',
  )
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([u]) => u.endsWith('/pricing-snapshot')),
    ).toBe(true),
  )
  expect(screen.getByLabelText('Collection amount')).toHaveValue('1.25')
  expect(fetcher.mock.calls.some(([u]) => u.startsWith(base))).toBe(false)
})
it('keeps amount read only and offers retry when its origin lookup fails', async () => {
  setup(
    billingPath + '/edit',
    grants(['billing.view', 'billing.update']),
    (u) =>
      u.endsWith('/pricing-snapshot')
        ? json({ error: { code: 'internal_error' } }, 500)
        : undefined,
  )
  await screen.findByLabelText('Collection amount')
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(screen.getByLabelText('Collection amount')).toHaveAttribute('readonly')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
})
it('rejects inactive selected dates and registers only safe pricing return routes', async () => {
  setup(detail, session, (u, i) =>
    u === base + '/' + sheetID && i.method === 'GET'
      ? json({
          data: {
            ...sheet,
            latest_version: { ...version, effective_from: '9999-01-01' },
          },
        })
      : undefined,
  )
  expect(
    await screen.findByRole('button', {
      name: 'Create collection from version',
    }),
  ).toBeDisabled()
  expect(screen.getByText(/not effective on the selected/)).toBeVisible()
  expect(safeReturnTo(detail + '/versions/' + versionID)).toBe(
    detail + '/versions/' + versionID,
  )
  expect(safeReturnTo(detail + '/new-version')).toBe(detail + '/new-version')
  expect(safeReturnTo(path + '/new/versions/' + versionID)).toBe('/app')
  expect(utcToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(
    pricingPermissions(grants(['pricing.manage']).user.permissions, clientID)
      .manage,
  ).toBe(false)
})
