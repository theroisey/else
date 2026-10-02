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
  actorID,
  clientID,
  date,
  detail,
  event,
  identity,
  otherID,
  page,
} from './fixtures.test-data'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup(
  session: Session = identity,
  read: (url: string) => Response | Promise<Response> = (url) =>
    json(url.includes('?') ? page([event()]) : { data: detail() }),
  path = '/app/audit',
) {
  let current = session
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: current }))
    if (
      (url.startsWith('/api/v1/audit-logs') ||
        url.startsWith(`/api/v1/clients/${clientID}/audit-logs`)) &&
      init.method === 'GET'
    )
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
it('reads global history with exact references and no directory calls, raw metadata or write controls', async () => {
  const { fetcher } = setup()
  const table = await screen.findByRole('table', { name: 'Audit events' })
  expect(within(table).getByText(date)).toHaveAttribute('datetime', date)
  expect(within(table).getByText(actorID)).toBeVisible()
  expect(
    screen.queryByText('Raw safe snapshots and metadata'),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Create|Edit|Archive|Delete/ }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === '/api/v1/auth/session' || url.startsWith('/api/v1/audit-logs?'),
    ),
  ).toBe(true)
})
it.each(['no audit', 'scoped audit', 'no client', 'foreign client'])(
  'denies %s before issuing any client audit request',
  async (kind) => {
    const grants =
      kind === 'no audit'
        ? identity.user.permissions.slice(1)
        : kind === 'scoped audit'
          ? [
              {
                permission: 'audit.view',
                scope: 'client' as const,
                client_id: clientID,
              },
              identity.user.permissions[1]!,
            ]
          : kind === 'no client'
            ? identity.user.permissions.slice(0, 1)
            : [
                identity.user.permissions[0]!,
                {
                  permission: 'clients.view',
                  scope: 'client' as const,
                  client_id: otherID,
                },
              ]
    const { fetcher } = setup(
      { ...identity, user: { ...identity.user, permissions: grants } },
      undefined,
      `/app/clients/${clientID}/audit`,
    )
    await screen.findByRole('heading', { name: 'Access denied' })
    expect(
      fetcher.mock.calls.some(([url]) => url.startsWith('/api/v1/clients')),
    ).toBe(false)
  },
)
it('renders exact client audit routes and suppresses invisible client events in global history', async () => {
  setup(
    {
      ...identity,
      user: { ...identity.user, permissions: [identity.user.permissions[0]!] },
    },
    () =>
      json(
        page([
          event(3, { client_id: null }),
          event(2),
          event(1, { client_id: otherID }),
        ]),
      ),
  )
  const table = await screen.findByRole('table', { name: 'Audit events' })
  expect(
    within(table).getAllByRole('button', { name: /Inspect/ }),
  ).toHaveLength(1)
  expect(within(table).getByText('Global')).toBeVisible()
  expect(within(table).queryByText(clientID)).not.toBeInTheDocument()
})
it('opens keyboard accessible details with exact safe differences, traps focus and returns it on Escape', async () => {
  const { fetcher } = setup(
    identity,
    undefined,
    `/app/clients/${clientID}/audit`,
  )
  const u = userEvent.setup()
  const trigger = await screen.findByRole('button', {
    name: /Inspect task.updated event/,
  })
  trigger.focus()
  await u.keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', {
    name: 'Audit event details',
  })
  await within(dialog).findByRole('table', { name: 'Safe field differences' })
  expect(within(dialog).getByText('9007199254740992')).toBeVisible()
  expect(within(dialog).getByText('9223372036854775807')).toBeVisible()
  expect(within(dialog).getByText('todo')).toBeVisible()
  expect(within(dialog).getByText('done')).toBeVisible()
  expect(
    within(dialog).getByRole('button', { name: 'Close details' }),
  ).toHaveFocus()
  await u.tab({ shift: true })
  expect(within(dialog).getByText('Raw safe snapshots and metadata')).toHaveFocus()
  await u.tab()
  expect(
    within(dialog).getByRole('button', { name: 'Close details' }),
  ).toHaveFocus()
  await u.click(within(dialog).getByText('Raw safe snapshots and metadata'))
  expect(within(dialog).getByText(/"source": "http"/)).toBeVisible()
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  expect(
    fetcher.mock.calls.some(
      ([url]) => url === `/api/v1/clients/${clientID}/audit-logs/${event().id}`,
    ),
  ).toBe(true)
})
it('preserves null and empty snapshots without inventing marker differences', async () => {
  setup(identity, (url) =>
    json(
      url.includes('?')
        ? page([event()])
        : { data: { ...detail(), before_state: null, after_state: {} } },
    ),
  )
  await userEvent
    .setup()
    .click(
      await screen.findByRole('button', { name: /Inspect task.updated event/ }),
    )
  await screen.findByText(
    'Before snapshot: Not recorded · After snapshot: Empty snapshot',
  )
  expect(screen.getByText('No marker differences recorded.')).toBeVisible()
})
it('shows pending and empty states, validates filters locally and sends only applied exact filters', async () => {
  let resolve!: (r: Response) => void
  let hold = true
  const { fetcher } = setup(identity, () =>
    hold
      ? new Promise((r) => {
          resolve = r
        })
      : json(page([])),
  )
  await screen.findByText('Loading audit history…')
  await act(async () => {
    hold = false
    resolve(json(page([])))
  })
  await screen.findByRole('heading', { name: 'No audit events on this page' })
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Actor ID'), 'invalid')
  const calls = fetcher.mock.calls.length
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await screen.findByRole('alert')
  expect(fetcher.mock.calls).toHaveLength(calls)
  await u.clear(screen.getByLabelText('Actor ID'))
  await u.type(screen.getByLabelText('Actor ID'), actorID)
  await u.type(
    screen.getByLabelText('From (UTC, inclusive)'),
    '2026-10-02T12:00:00.123456Z',
  )
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)![0]).toContain(
      'from=2026-10-02T12%3A00%3A00.123456Z',
    ),
  )
  await u.click(screen.getByRole('button', { name: 'Clear filters' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)![0]).toBe('/api/v1/audit-logs?limit=25'),
  )
})
it('does not request an inaccessible selected client and offers filter recovery', async () => {
  const { fetcher } = setup()
  await screen.findByRole('table', { name: 'Audit events' })
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Client ID'), otherID)
  const calls = fetcher.mock.calls.length
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await screen.findByText(/This client is not available/)
  expect(fetcher.mock.calls).toHaveLength(calls)
  await u.click(screen.getByRole('button', { name: 'Clear filters' }))
  await screen.findByRole('table', { name: 'Audit events' })
})
it('pages using unchanged cursors, resets them when filters change and refreshes newest history', async () => {
  const { fetcher } = setup(identity, (url) =>
    json(
      new URL(url, 'https://fixture.test').searchParams.has('cursor')
        ? page([event()])
        : new URL(url, 'https://fixture.test').searchParams.has('event_type')
          ? page([])
          : page(
              Array.from({ length: 25 }, (_, i) => event(30 - i)),
              'opaque_Cursor-1',
            ),
    ),
  )
  const u = userEvent.setup()
  await screen.findByRole('table', { name: 'Audit events' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', { name: /Inspect task.updated event/ }),
    ).toHaveLength(1),
  )
  expect(fetcher.mock.calls.at(-1)![0]).toContain('cursor=opaque_Cursor-1')
  await u.click(screen.getByRole('button', { name: 'Previous' }))
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', { name: /Inspect task.updated event/ }),
    ).toHaveLength(25),
  )
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', { name: /Inspect task.updated event/ }),
    ).toHaveLength(1),
  )
  await u.type(screen.getByLabelText('Event type'), 'task.created')
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await screen.findByRole('heading', { name: 'No audit events on this page' })
  expect(fetcher.mock.calls.at(-1)![0]).not.toContain('cursor=')
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Refresh audit history' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.at(-1)![0]).toContain('event_type=task.created'),
  )
})
it('rejects expanded details and safe server errors, then retries without stale raw data', async () => {
  let bad = true
  setup(identity, (url) =>
    json(
      url.includes('?')
        ? page([event()])
        : {
            data: {
              ...detail(),
              ...(bad ? { actor_email: 'Synthetic secret' } : {}),
            },
          },
    ),
  )
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', { name: /Inspect task.updated event/ }),
  )
  await screen.findByRole('alert')
  expect(screen.queryByText(/Synthetic secret/)).not.toBeInTheDocument()
  expect(
    screen.queryByText('Raw safe snapshots and metadata'),
  ).not.toBeInTheDocument()
  bad = false
  await u.click(screen.getByRole('button', { name: 'Retry details' }))
  await screen.findByRole('table', { name: 'Safe field differences' })
})
it('suppresses cached summary and detail during failing background reads', async () => {
  let failed = false
  const { cache } = setup(identity, (url) =>
    failed
      ? json(
          { error: { code: 'internal_error', message: 'Synthetic secret' } },
          500,
        )
      : json(url.includes('?') ? page([event()]) : { data: detail() }),
  )
  await userEvent
    .setup()
    .click(
      await screen.findByRole('button', { name: /Inspect task.updated event/ }),
    )
  await screen.findByRole('table', { name: 'Safe field differences' })
  failed = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['audit'] })
  })
  await screen.findByRole('alert')
  expect(
    screen.queryByRole('table', { name: 'Audit events' }),
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText(/Synthetic secret/)).not.toBeInTheDocument()
  failed = false
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('table', { name: 'Audit events' })
})
it('closes on revoked access and suppresses late detail responses across actor/grant changes', async () => {
  let resolve!: (r: Response) => void
  const { setSession } = setup(identity, (url) =>
    url.includes('?')
      ? json(page([event()]))
      : new Promise((r) => {
          resolve = r
        }),
  )
  await userEvent
    .setup()
    .click(
      await screen.findByRole('button', { name: /Inspect task.updated event/ }),
    )
  await screen.findByText('Loading audit details…')
  setSession({
    ...identity,
    user: { ...identity.user, id: otherID, permissions: [] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  await act(async () => resolve(json({ data: detail() })))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('9223372036854775807')).not.toBeInTheDocument()
})
it('does not reopen explicitly closed details when a pending response arrives', async () => {
  let resolve!: (r: Response) => void
  setup(identity, (url) =>
    url.includes('?')
      ? json(page([event()]))
      : new Promise((r) => {
          resolve = r
        }),
  )
  const u = userEvent.setup()
  const trigger = await screen.findByRole('button', {
    name: /Inspect task.updated event/,
  })
  await u.click(trigger)
  await screen.findByText('Loading audit details…')
  await u.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
  await act(async () => resolve(json({ data: detail() })))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('9223372036854775807')).not.toBeInTheDocument()
})
it('rechecks the session after a server denial and removes revoked audit navigation/history', async () => {
  let denied = false
  const { setServerSession } = setup(identity, () =>
    denied
      ? json({ error: { code: 'permission_denied' } }, 403)
      : json(page([event()])),
  )
  await screen.findByRole('table', { name: 'Audit events' })
  denied = true
  setServerSession({
    ...identity,
    user: { ...identity.user, permissions: [] },
  })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh audit history' }))
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(
    screen.queryByRole('link', { name: 'Audit history' }),
  ).not.toBeInTheDocument()
})
it('rejects malformed client routes before any private read', async () => {
  const { fetcher } = setup(identity, undefined, '/app/clients/invalid/audit')
  await screen.findByRole('heading', { name: 'Audit history not found' })
  expect(
    fetcher.mock.calls.some(([url]) => url.startsWith('/api/v1/clients')),
  ).toBe(false)
})
