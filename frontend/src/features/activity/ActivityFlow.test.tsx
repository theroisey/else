import { expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  event,
  page,
  clientID,
  identity,
  otherID,
  date,
} from './fixtures.test-data'
const base = `/api/v1/clients/${clientID}/activity`
const route = `/app/clients/${clientID}/activity`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup(
  session: Session = identity,
  read: (url: string) => Response | Promise<Response> = () =>
    json(page([event()])),
  path = route,
) {
  let current = session
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: current }))
    if (url.startsWith(base + '?') && init.method === 'GET')
      return Promise.resolve(read(url))
    throw new Error('Unexpected private request: ' + url)
  })
  vi.stubGlobal('fetch', fetcher)
  const cache = createQueryClient()
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    fetcher,
    cache,
    setServerSession: (next: Session) => {
      current = next
    },
    setSession: (next: Session) => {
      current = next
      act(() =>
        cache.setQueryData(sessionKey, { session: current, expired: false }),
      )
    },
  }
}
const root = {
  ...identity,
  user: {
    ...identity.user,
    permissions: identity.user.permissions.filter((g) =>
      ['clients.view', 'activity.view'].includes(g.permission),
    ),
  },
}
it('renders persisted client events with exact UTC time and no detail/directory reads or write controls', async () => {
  const { fetcher } = setup(root, () =>
    json(page([event(1, 'client.archived')])),
  )
  await screen.findByRole(
    'list',
    { name: 'Client activity' },
    { timeout: 5000 },
  )
  expect(screen.getByText('Client archived.')).toBeVisible()
  expect(
    screen.getByText(
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(date)),
    ),
  ).toHaveAttribute('datetime', date)
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
      'Activity',
    ),
  ).toBeVisible()
  expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Create|Archive|Edit|Complete/ }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === '/api/v1/auth/session' ||
        url === '/api/v1/auth/preferences' ||
        url.startsWith(base + '?'),
    ),
  ).toBe(true)
})
it.each(['clients.view', 'activity.view'])(
  'denies missing %s before any private activity read',
  async (permission) => {
    const { fetcher } = setup({
      ...identity,
      user: {
        ...identity.user,
        permissions: identity.user.permissions.filter(
          (g) => g.permission !== permission,
        ),
      },
    })
    await screen.findByRole('heading', { name: 'Access denied' })
    expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
  },
)
it('denies foreign-client grants before private reads', async () => {
  const { fetcher } = setup({
    ...identity,
    user: {
      ...identity.user,
      permissions: identity.user.permissions.map((g) => ({
        ...g,
        client_id: otherID,
      })),
    },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
})
it('shows pending then permitted empty state without inventing events', async () => {
  let resolve!: (response: Response) => void
  setup(
    identity,
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  await screen.findByText('Loading activity…')
  expect(
    screen.queryByRole('list', { name: 'Client activity' }),
  ).not.toBeInTheDocument()
  await act(async () => resolve(json(page([]))))
  await screen.findByRole('heading', { name: 'No activity on this page' })
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})
it('pages with opaque cursors, goes back and refreshes the newest first page', async () => {
  let refreshed = false
  const { fetcher } = setup(identity, (url) =>
    json(
      new URL(url, 'https://fixture.test').searchParams.has('cursor')
        ? page([event(1, 'task.completed')])
        : refreshed
          ? page([event(40, 'client.archived')])
          : page(
              Array.from({ length: 25 }, (_, i) => event(30 - i)),
              'opaque_Cursor-1',
            ),
    ),
  )
  const u = userEvent.setup()
  await screen.findByRole('list', { name: 'Client activity' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('Task completed.')
  expect(fetcher.mock.calls.at(-1)![0]).toContain('cursor=opaque_Cursor-1')
  await u.click(screen.getByRole('button', { name: 'Previous' }))
  await waitFor(() =>
    expect(
      within(
        screen.getByRole('list', { name: 'Client activity' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(25),
  )
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('Task completed.')
  refreshed = true
  await u.click(screen.getByRole('button', { name: 'Refresh activity' }))
  await screen.findByText('Client archived.')
  expect(fetcher.mock.calls.at(-1)![0]).not.toContain('cursor=')
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
})
it('rejects expanded responses and permits retry without rendering private metadata', async () => {
  let malformed = true
  setup(identity, () =>
    json(
      page([
        {
          ...event(),
          ...(malformed ? { metadata: 'Synthetic private title' } : {}),
        },
      ]),
    ),
  )
  await screen.findByRole('alert')
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
  expect(screen.queryByText(/Synthetic private title/)).not.toBeInTheDocument()
  malformed = false
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('Task updated.')
})
it('suppresses cached rows when a background read fails and restores only confirmed reads', async () => {
  let failed = false
  const { cache } = setup(identity, () =>
    failed
      ? json(
          { error: { code: 'internal_error', message: 'Synthetic secret' } },
          500,
        )
      : json(page([event()])),
  )
  await screen.findByText('Task updated.')
  failed = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['activity'] })
  })
  await screen.findByRole('alert')
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
  expect(screen.queryByText('Synthetic secret')).not.toBeInTheDocument()
  failed = false
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('Task updated.')
})
it('immediately partitions grant changes and suppresses a late domain result', async () => {
  let hold = false
  let resolve!: (response: Response) => void
  const { cache, setSession } = setup(identity, () =>
    hold
      ? new Promise((r) => {
          resolve = r
        })
      : json(page([event(2), event(1, 'client.updated')])),
  )
  await screen.findByText('Task updated.')
  hold = true
  let pending!: Promise<void>
  act(() => {
    pending = cache.invalidateQueries({ queryKey: ['activity'] })
  })
  await screen.findByText('Loading activity…')
  hold = false
  setSession(root)
  await screen.findByText('Client updated.')
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument()
  await act(async () => {
    resolve(json(page([event(3, 'task.completed')])))
    await pending
  })
  expect(screen.queryByText('Task completed.')).not.toBeInTheDocument()
  expect(screen.getByText('Client updated.')).toBeVisible()
})
it('removes rows immediately when root access is revoked without another private read', async () => {
  const { fetcher, setSession } = setup()
  await screen.findByText('Task updated.')
  const before = fetcher.mock.calls.filter(([url]) =>
    url.startsWith(base),
  ).length
  setSession({ ...identity, user: { ...identity.user, permissions: [] } })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.filter(([url]) => url.startsWith(base)),
  ).toHaveLength(before)
})
it('rechecks session on server-side denial and hides revoked root access', async () => {
  let denied = false
  const context = setup(identity, () =>
    denied
      ? json({ error: { code: 'not_found' } }, 404)
      : json(page([event()])),
  )
  await screen.findByText('Task updated.')
  denied = true
  context.setServerSession({
    ...identity,
    user: {
      ...identity.user,
      permissions: identity.user.permissions.filter(
        (g) => g.permission !== 'activity.view',
      ),
    },
  })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh activity' }))
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
})
it('partitions a replacement actor and never carries the previous timeline forward', async () => {
  let next = false
  const { setSession } = setup(identity, () =>
    json(page([event(1, next ? 'client.created' : 'task.updated')])),
  )
  await screen.findByText('Task updated.')
  next = true
  setSession({
    ...root,
    user: { ...root.user, id: otherID, display_name: 'Replacement Actor' },
  })
  await screen.findByText('Client created.')
  expect(screen.queryByText('Task updated.')).not.toBeInTheDocument()
})
it('rejects a malformed client route before issuing a private request', async () => {
  const { fetcher } = setup(
    identity,
    () => json(page([event()])),
    '/app/clients/invalid/activity',
  )
  await screen.findByRole('heading', { name: 'Activity not found' })
  expect(
    fetcher.mock.calls.some(([url]) => url.startsWith('/api/v1/clients')),
  ).toBe(false)
})
