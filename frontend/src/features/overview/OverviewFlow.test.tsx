import { expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  clientID,
  otherID,
  actorID,
  identity,
  overview,
  task,
  event,
} from './fixtures.test-data'
const base = `/api/v1/clients/${clientID}/overview`,
  route = `/app/clients/${clientID}`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup(
  session: Session = identity,
  read: () => Response | Promise<Response> = () => json({ data: overview() }),
  path = route,
) {
  let current = session
  const fetcher = vi.fn((url: string) => {
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: current }))
    if (url === base) return Promise.resolve(read())
    throw new Error('Unexpected private request ' + url)
  })
  vi.stubGlobal('fetch', fetcher)
  const cache = createQueryClient()
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <StrictMode>
          <App />
        </StrictMode>
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
it('shows exact finance, prioritized attention, real activity and honest integrations with one aggregate read', async () => {
  const { fetcher } = setup()
  await screen.findByRole(
    'heading',
    { name: 'Synthetic overview client' },
    { timeout: 5000 },
  )
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent),
  ).toEqual([
    'Financial position',
    'Needs attention',
    'Next seven days',
    'Recent activity',
    'Measured intelligence',
  ])
  expect(
    screen.getByRole('link', { name: 'Synthetic task 1' }),
  ).toHaveAttribute('href', `/app/clients/${clientID}/tasks/${task().id}`)
  expect(
    screen.getAllByText(
      (_, element) =>
        ['P', 'DD'].includes(element?.tagName ?? '') &&
        element?.textContent === 'USD 7.50',
    ),
  ).toHaveLength(2)
  expect(screen.getByText('Client created.')).toBeVisible()
  expect(screen.getAllByText(/Europe\/Istanbul/)).toHaveLength(2)
  expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'href',
    route + '/profile',
  )
  expect(
    screen.queryByRole('button', { name: /Create|Archive|Complete/ }),
  ).not.toBeInTheDocument()
  expect(fetcher.mock.calls.filter(([url]) => url === base)).toHaveLength(1)
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === base ||
        url === '/api/v1/auth/session' ||
        url === '/api/v1/auth/preferences',
    ),
  ).toBe(true)
})
it.each(Array.from({ length: 16 }, (_, i) => i))(
  'masks independent module combination %i without hidden placeholders',
  async (mask) => {
    const modules = [
      'billing.view',
      'tasks.view',
      'reminders.view',
      'activity.view',
    ]
    const session = {
      ...identity,
      user: {
        ...identity.user,
        permissions: identity.user.permissions.filter(
          (g) =>
            g.permission === 'clients.view' ||
            modules.some((key, i) => key === g.permission && mask & (1 << i)),
        ),
      },
    }
    setup(session)
    await screen.findByRole('heading', { name: 'Synthetic overview client' })
    expect(
      !!screen.queryByRole('heading', { name: 'Financial position' }),
    ).toBe(!!(mask & 1))
    expect(!!screen.queryByRole('heading', { name: 'Overdue tasks' })).toBe(
      !!(mask & 2),
    )
    expect(!!screen.queryByRole('heading', { name: 'Due reminders' })).toBe(
      !!(mask & 4),
    )
    expect(!!screen.queryByRole('heading', { name: 'Recent activity' })).toBe(
      !!(mask & 8),
    )
    expect(
      screen.queryByText(/permission required|hidden count/i),
    ).not.toBeInTheDocument()
  },
)
it.each(['no profile access', 'foreign scope', 'invalid route'])(
  'denies %s without a private read',
  async (scenario) => {
    const session = {
      ...identity,
      user: {
        ...identity.user,
        permissions:
          scenario === 'no profile access'
            ? identity.user.permissions.filter(
                (g) => g.permission !== 'clients.view',
              )
            : identity.user.permissions.map((g) => ({
                ...g,
                client_id: otherID,
              })),
      },
    }
    const { fetcher } = setup(
      session,
      undefined,
      scenario === 'invalid route' ? '/app/clients/invalid' : route,
    )
    await screen.findByRole('heading', {
      name:
        scenario === 'invalid route' ? 'Overview not found' : 'Access denied',
    })
    expect(
      fetcher.mock.calls.every(
        ([url]) =>
          url === '/api/v1/auth/session' || url === '/api/v1/auth/preferences',
      ),
    ).toBe(true)
  },
)
it('renders authorized empties and archived context without inventing zero totals or write controls', async () => {
  const v = overview()
  v.client.status = 'archived'
  v.client.archived_at = v.as_of
  v.finance!.currencies = []
  v.tasks!.overdue.items = []
  v.tasks!.due_soon.items = []
  v.reminders!.due.items = []
  v.reminders!.upcoming.items = []
  v.activity!.items = []
  setup(identity, () => json({ data: v }))
  await screen.findByText('No balances recorded yet.')
  expect(screen.getByText('No overdue tasks.')).toBeVisible()
  expect(screen.getByText('No reminders due.')).toBeVisible()
  expect(screen.getByText('No recent activity visible.')).toBeVisible()
  expect(screen.getByText(/overview and history remain readable/)).toBeVisible()
  expect(screen.queryByText('USD 0.00')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Archive|Edit/ }),
  ).not.toBeInTheDocument()
})
it('hides stale data during explicit refresh, then renders safe failure and permits a fresh retry', async () => {
  let reads = 0,
    release!: (r: Response) => void
  const { fetcher } = setup(identity, () =>
    ++reads === 1
      ? json({ data: overview() })
      : reads === 2
        ? new Promise((r) => {
            release = r
          })
        : json({ data: overview() }),
  )
  await screen.findByRole('heading', { name: 'Synthetic overview client' })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh overview' }))
  await screen.findByText('Loading overview…')
  expect(screen.queryByText('Synthetic task 1')).not.toBeInTheDocument()
  await act(async () =>
    release(
      json(
        {
          error: {
            code: 'internal_error',
            message: 'Synthetic private failure',
          },
        },
        500,
      ),
    ),
  )
  expect(await screen.findByRole('alert')).not.toHaveTextContent(
    'Synthetic private failure',
  )
  expect(
    screen.queryByRole('heading', { name: 'Financial position' }),
  ).not.toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('heading', { name: 'Financial position' })
  expect(fetcher.mock.calls.filter(([url]) => url === base)).toHaveLength(3)
})
it('hides expanded invalid responses before any private value appears', async () => {
  const v = overview()
  Object.assign(v.client, { notes: 'Synthetic private profile' })
  setup(identity, () => json({ data: v }))
  await screen.findByRole('heading', { name: 'Overview unavailable' })
  expect(document.body).not.toHaveTextContent('Synthetic private profile')
  expect(screen.queryByText('Synthetic task 1')).not.toBeInTheDocument()
})
it('refreshes access before the overview and drops revoked modules immediately', async () => {
  const f = setup()
  await screen.findByRole('heading', { name: 'Financial position' })
  f.setServerSession({
    ...identity,
    user: {
      ...identity.user,
      permissions: identity.user.permissions.filter(
        (g) => g.permission !== 'billing.view',
      ),
    },
  })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh overview' }))
  await screen.findByRole('heading', { name: 'Synthetic overview client' })
  expect(
    screen.queryByRole('heading', { name: 'Financial position' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Finance' }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Overdue tasks' })).toBeVisible()
  expect(f.fetcher.mock.calls.filter(([url]) => url === base)).toHaveLength(2)
})
it('suppresses late responses after actor and grants change and clears data on session loss', async () => {
  let release!: (r: Response) => void,
    reads = 0
  const f = setup(identity, () =>
    ++reads === 1
      ? new Promise((r) => {
          release = r
        })
      : json({
          data: {
            ...overview(),
            client: { ...overview().client, name: 'Fresh client context' },
            finance: undefined,
            tasks: undefined,
            reminders: undefined,
            activity: undefined,
          },
        }),
  )
  await screen.findByText('Loading overview…')
  f.setSession({
    ...identity,
    user: {
      ...identity.user,
      id: otherID,
      permissions: [
        { permission: 'clients.view', scope: 'client', client_id: clientID },
      ],
    },
  })
  await screen.findByRole('heading', { name: 'Fresh client context' })
  await act(async () => release(json({ data: overview() })))
  expect(screen.queryByText('Synthetic task 1')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('heading', { name: 'Financial position' }),
  ).not.toBeInTheDocument()
  act(() => f.cache.setQueryData(sessionKey, { session: null, expired: true }))
  await screen.findByRole('heading', { name: 'Sign in' })
  await waitFor(() =>
    expect(
      f.cache.getQueriesData({ queryKey: ['overview', actorID] }),
    ).toHaveLength(0),
  )
})
it('keeps more links bounded and excludes hidden source activity indicators', async () => {
  const v = overview()
  v.tasks!.due_soon.items = [task(6, '2026-10-03T12:00:00Z')]
  v.tasks!.overdue = {
    items: Array.from({ length: 5 }, (_, i) => task(i + 1)),
    has_more: true,
  }
  v.activity = {
    items: [
      event(5, 'task'),
      event(4, 'task'),
      event(3, 'task'),
      event(2, 'task'),
      event(1, 'client'),
    ],
    has_more: true,
  }
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: identity.user.permissions.filter(
        (g) => g.permission !== 'tasks.view',
      ),
    },
  }
  setup(session, () => json({ data: v }))
  await screen.findByRole('heading', { name: 'Recent activity' })
  expect(
    within(
      screen.getByRole('list', { name: 'Recent client activity' }),
    ).getAllByRole('listitem'),
  ).toHaveLength(1)
  expect(screen.queryByText(/More activity available/)).not.toBeInTheDocument()
  expect(screen.queryByText(/More overdue tasks/)).not.toBeInTheDocument()
})
