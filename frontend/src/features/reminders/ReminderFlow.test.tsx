import { afterEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  reminder,
  identity,
  clientID,
  actorID,
  recordID,
  taskID,
  planID,
  milestoneID,
  date,
} from './fixtures.test-data'
import type { RecordData } from './models'
import { utcFromWall } from './time'
import { plan, milestone } from '../planning/fixtures.test-data'
const base = `/api/v1/clients/${clientID}/reminders`,
  route = `/app/clients/${clientID}/reminders`,
  edit = route + '/' + recordID + '/edit'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const page = (data: unknown[], next_cursor: string | null = null) => ({
  data,
  page: { limit: 25, next_cursor },
})
type Override = (url: string, init: RequestInit) => Response | Promise<Response> | undefined
function setup(
  path = route,
  session: Session = identity,
  override: Override = () => undefined,
  initial: RecordData = reminder,
) {
  const record = structuredClone(initial)
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/session') return Promise.resolve(json({ data: session }))
    if (url.startsWith(base + '/owners?'))
      return Promise.resolve(json(page([{ id: actorID, display_name: 'Eligible Owner' }])))
    if (init.method === 'GET') {
      if (url.startsWith(base + '?')) return Promise.resolve(json(page([record])))
      if (url === base + '/' + recordID) return Promise.resolve(json({ data: record }))
      throw new Error('Unexpected private read: ' + url)
    }
    const body = JSON.parse(init.body as string)
    if (url.endsWith('/complete') || url.endsWith('/dismiss')) {
      record.status = url.endsWith('/complete') ? 'completed' : 'dismissed'
      record.is_due = false
      record.completed_at = record.status === 'completed' ? date : null
      record.dismissed_at = record.status === 'dismissed' ? date : null
    } else {
      const { expected_revision, ...metadata } = body
      Object.assign(record, metadata)
      record.scheduled_at = utcFromWall(record.scheduled_local, record.utc_offset_seconds)
      void expected_revision
    }
    record.revision = body.expected_revision ? body.expected_revision + 1 : 1
    return Promise.resolve(json({ data: { id: record.id, revision: record.revision } }))
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
  return { fetcher, cache, record }
}
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
const writeCalls = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.filter(([, init]) => ['POST', 'PUT'].includes(init.method))
async function fillSchedule(local: string, timezone = 'America/New_York') {
  fireEvent.change(screen.getByLabelText('Scheduled date'), {
    target: { value: local.slice(0, 10) },
  })
  fireEvent.change(screen.getByLabelText('Local time'), { target: { value: local.slice(11) } })
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: timezone } })
}
it('opens reminder-only scoped views without client/resource/directory reads or write controls', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        { permission: 'reminders.view', scope: 'client' as const, client_id: clientID },
      ],
    },
  }
  const { fetcher } = setup(route, session)
  await screen.findByRole('link', { name: 'Open Reminder Fixture' }, { timeout: 5000 })
  expect(screen.queryByRole('link', { name: 'Create reminder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(([url]) => url === '/api/v1/auth/session' || url.startsWith(base)),
  ).toBe(true)
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Reminders'),
  ).toBeVisible()
})
it('denies write-only or foreign-client grants before private reads', async () => {
  const { fetcher } = setup(edit, {
    ...identity,
    user: { ...identity.user, permissions: [{ permission: 'reminders.update', scope: 'global' }] },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(base))).toBe(false)
})
it('requires explicit repeated-hour choice and submits the selected UTC offset with microseconds', async () => {
  const { fetcher } = setup(route + '/new'),
    u = userEvent.setup()
  await screen.findByLabelText('Reminder title')
  await u.type(screen.getByLabelText('Reminder title'), ' Created Reminder ')
  await fillSchedule('2026-11-01T01:30:00.123456')
  await u.click(screen.getByRole('button', { name: 'Create reminder' }))
  await screen.findByRole('alert')
  expect(writeCalls(fetcher)).toHaveLength(0)
  await u.click(screen.getByRole('radio', { name: /Later occurrence/ }))
  await u.click(screen.getByRole('button', { name: 'Create reminder' }))
  await screen.findByRole('heading', { name: 'Created Reminder' })
  const body = JSON.parse(writeCalls(fetcher)[0]![1].body)
  expect(body).toEqual({
    title: 'Created Reminder',
    description: '',
    owner_id: actorID,
    scheduled_local: '2026-11-01T01:30:00.123456',
    timezone: 'America/New_York',
    utc_offset_seconds: -18000,
    resource: null,
  })
  expect(body).not.toHaveProperty('scheduled_at')
})
it('rejects a nonexistent local time and retains the typed draft', async () => {
  const { fetcher } = setup(route + '/new'),
    u = userEvent.setup()
  await screen.findByLabelText('Reminder title')
  await u.type(screen.getByLabelText('Reminder title'), 'Gap draft')
  await fillSchedule('2026-03-08T02:30:00')
  await u.click(screen.getByRole('button', { name: 'Create reminder' }))
  expect(screen.getByLabelText('Local time')).toHaveValue('02:30:00')
  expect(screen.getAllByText(/This local time does not exist/).length).toBeGreaterThan(0)
  expect(writeCalls(fetcher)).toHaveLength(0)
})
it('preserves the recorded later occurrence and microseconds when metadata changes', async () => {
  const { fetcher } = setup(edit),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  expect(screen.getByLabelText('Local time')).toHaveValue('01:30:00.123456')
  await u.clear(screen.getByLabelText('Reminder title'))
  await u.type(screen.getByLabelText('Reminder title'), 'Changed Reminder')
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Changed Reminder' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body)).toMatchObject({
    scheduled_local: reminder.scheduled_local,
    utc_offset_seconds: -18000,
    expected_revision: 1,
  })
})
it('can deliberately change the occurrence without changing the wall clock', async () => {
  const { fetcher } = setup(edit),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  await u.click(screen.getByRole('radio', { name: /Earlier occurrence/ }))
  await screen.findByText(/Scheduled UTC instant:/)
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).utc_offset_seconds).toBe(-14400)
})
it('keeps typed wall time and clears a new occurrence when timezone changes', async () => {
  setup(route + '/new')
  const u = userEvent.setup()
  await screen.findByLabelText('Reminder title')
  await fillSchedule('2026-11-01T01:30:00')
  await u.click(screen.getByRole('radio', { name: /Later occurrence/ }))
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'UTC' } })
  expect(screen.getByLabelText('Local time')).toHaveValue('01:30:00')
  expect(screen.getByText('2026-11-01T01:30:00Z')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } })
  expect(screen.getByRole('radio', { name: /Later occurrence/ })).not.toBeChecked()
})
it('preserves drafts and captured revision through conflict until explicit reload', async () => {
  let stale = false
  const { fetcher } = setup(edit, identity, (url, init) => {
      if (init.method === 'PUT') {
        stale = true
        return json({ error: { code: 'conflict' } }, 409)
      }
      if (stale && url === base + '/' + recordID)
        return json({ data: { ...reminder, title: 'Current Reminder', revision: 3 } })
    }),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  await u.clear(screen.getByLabelText('Reminder title'))
  await u.type(screen.getByLabelText('Reminder title'), 'Unsaved draft')
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByText(/Your draft is preserved/)
  expect(screen.getByLabelText('Reminder title')).toHaveValue('Unsaved draft')
  expect(screen.getByRole('button', { name: 'Save reminder' })).toBeDisabled()
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).expected_revision).toBe(1)
  await u.click(screen.getByRole('button', { name: 'Reload current data' }))
  await screen.findByDisplayValue('Current Reminder')
  expect(screen.getByRole('button', { name: 'Save reminder' })).toBeEnabled()
})
it('keeps a mounted draft through failed background refresh and blocks saving until recovery', async () => {
  let fail = false
  const { cache } = setup(edit, identity, (url, init) =>
      fail && url === base + '/' + recordID && init.method === 'GET'
        ? json({ error: { code: 'request_failed' } }, 500)
        : undefined,
    ),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  await u.type(screen.getByLabelText('Reminder title'), ' draft')
  fail = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['reminders', actorID] })
  })
  expect(screen.getByLabelText('Reminder title')).toHaveValue('Reminder Fixture draft')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save reminder' })).toBeDisabled())
  fail = false
  await u.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save reminder' })).toBeEnabled())
  expect(screen.getByLabelText('Reminder title')).toHaveValue('Reminder Fixture draft')
})
it('treats completed/dismissed details and editor routes as immutable history', async () => {
  const { fetcher } = setup(edit, identity, () => undefined, {
    ...reminder,
    status: 'completed',
    completed_at: date,
  })
  await screen.findByDisplayValue('Reminder Fixture')
  expect(screen.getByLabelText('Reminder title')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save reminder' })).toBeDisabled()
  expect(writeCalls(fetcher)).toHaveLength(0)
})
it('completes explicitly with a captured revision and server-confirmed terminal state', async () => {
  const { fetcher } = setup(route + '/' + recordID),
    u = userEvent.setup()
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  await u.click(screen.getByRole('button', { name: 'Complete' }))
  await screen.findByText('Completed', { selector: 'dt' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body)).toEqual({ expected_revision: 1 })
  expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Edit reminder' })).not.toBeInTheDocument()
})
it('requires Cancel-first dismissal confirmation and retains terminal history', async () => {
  const { fetcher } = setup(route + '/' + recordID),
    u = userEvent.setup()
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  await u.click(screen.getByRole('button', { name: 'Dismiss' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  expect(writeCalls(fetcher)).toHaveLength(0)
  await u.click(within(dialog).getByRole('button', { name: 'Confirm dismissal' }))
  await screen.findByText('Dismissed', { selector: 'dt' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body)).toEqual({
    expected_revision: 1,
    confirm: true,
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
it('retains historical resource IDs without independent reads and allows clearing them', async () => {
  const { fetcher } = setup(edit, identity, () => undefined, {
      ...reminder,
      resource: { kind: 'task', id: taskID },
    }),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  expect(screen.getByText('task · ' + taskID)).toBeVisible()
  expect(fetcher.mock.calls.some(([url]) => url.includes('/tasks'))).toBe(false)
  await u.click(screen.getByRole('button', { name: 'Clear reference' }))
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).resource).toBeNull()
})
it('pages eligible owners without losing the historical selection', async () => {
  const owners = Array.from({ length: 25 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i + 1).padStart(12, '0')}`,
      display_name: `Owner ${i + 1}`,
    })),
    cursor = owners.at(-1)!.id
  const { fetcher } = setup(
      edit,
      identity,
      (url) =>
        url.startsWith(base + '/owners?')
          ? json(
              page(
                url.includes('cursor=') ? [{ id: actorID, display_name: 'Final Owner' }] : owners,
                url.includes('cursor=') ? null : cursor,
              ),
            )
          : undefined,
      { ...reminder, owner_id: taskID },
    ),
    u = userEvent.setup()
  await screen.findByRole('option', { name: 'Owner 1' })
  expect(screen.getByLabelText('Owner')).toHaveValue(taskID)
  await u.click(screen.getByRole('button', { name: 'Next owners' }))
  await screen.findByRole('option', { name: 'Final Owner' })
  expect(screen.getByLabelText('Owner')).toHaveValue(taskID)
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor=' + cursor))).toBe(true)
  await u.selectOptions(screen.getByLabelText('Owner'), actorID)
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).owner_id).toBe(actorID)
})
it('browses authorized plan and milestone candidates through an explicit parent choice', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        { permission: 'planning.view', scope: 'client' as const, client_id: clientID },
      ],
    },
  }
  const { fetcher } = setup(edit, session, (url) =>
      url.includes('/plans?')
        ? json(page([plan]))
        : url.includes('/milestones?')
          ? json(page([milestone]))
          : undefined,
    ),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  await u.selectOptions(screen.getByLabelText('Browse resources'), 'milestone')
  await screen.findByText('Plan Fixture')
  await u.click(screen.getByRole('button', { name: 'Open milestones' }))
  await screen.findByText('Milestone Fixture')
  await u.click(screen.getByRole('button', { name: 'Select reference' }))
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).resource).toEqual({
    kind: 'milestone',
    id: milestoneID,
  })
  expect(
    fetcher.mock.calls.some(([url]) => url.includes('/plans/' + planID + '/milestones?')),
  ).toBe(true)
})
it('removes resource titles on revocation, retains selected IDs and blocks unauthorized new links', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        { permission: 'tasks.view', scope: 'client' as const, client_id: clientID },
      ],
    },
  }
  const { cache, fetcher } = setup(edit, session, (url) =>
      url.includes('/tasks?')
        ? json(
            page([
              {
                ...reminder,
                id: taskID,
                title: 'Private Candidate',
                status: 'todo',
                priority: 'medium',
                assignee_id: null,
                start_at: null,
                due_at: null,
                completed_at: null,
                cancelled_at: null,
                archived_at: null,
                tags: [],
              },
            ]),
          )
        : undefined,
    ),
    u = userEvent.setup()
  await screen.findByText('Private Candidate')
  await u.click(screen.getByRole('button', { name: 'Select reference' }))
  session.user.permissions = identity.user.permissions
  await act(async () => {
    cache.setQueryData(sessionKey, { session: identity })
  })
  await waitFor(() => expect(screen.queryByText('Private Candidate')).not.toBeInTheDocument())
  expect(screen.getByText('task · ' + taskID)).toBeVisible()
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByText(/Clear the new reference/)
  expect(writeCalls(fetcher)).toHaveLength(0)
  await u.click(screen.getByRole('button', { name: 'Clear reference' }))
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
})
it('handles empty and failed real-record views without fabricating delivery results', async () => {
  let failed = false
  setup(route, identity, (url) =>
    url.startsWith(base + '?')
      ? failed
        ? json({ error: { code: 'request_failed' } }, 500)
        : json(page([]))
      : undefined,
  )
  await screen.findByRole('heading', { name: 'No reminders on this page' })
  failed = true
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh reminders' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument()
})
it('drops private reminder content when the session expires', async () => {
  let expired = false
  const { cache } = setup(route + '/' + recordID, identity, (url) =>
    expired && url === '/api/v1/auth/session'
      ? json({ error: { code: 'authentication_required' } }, 401)
      : undefined,
  )
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expired = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: sessionKey })
  })
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(screen.queryByText('Synthetic private reminder text')).not.toBeInTheDocument()
  expect(cache.getQueriesData({ queryKey: ['reminders'] }).length).toBe(0)
})
it('pages fixed-size lists and resets the cursor when due/owner/title filters change', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
      ...reminder,
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i + 1).padStart(12, '0')}`,
      title: `Page Reminder ${i + 1}`,
    })),
    cursor = rows.at(-1)!.id
  const { fetcher } = setup(route, identity, (url) =>
      url.startsWith(base + '?')
        ? json(page(url.includes('cursor=') ? [] : rows, url.includes('cursor=') ? null : cursor))
        : undefined,
    ),
    u = userEvent.setup()
  await screen.findByRole('link', { name: 'Open Page Reminder 1' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('heading', { name: 'No reminders on this page' })
  await u.selectOptions(screen.getByLabelText('Schedule view'), 'due')
  await u.clear(screen.getByLabelText('Owner filter'))
  await u.type(screen.getByLabelText('Owner filter'), 'me')
  await u.type(screen.getByLabelText('Search reminders'), '%')
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await screen.findByRole('link', { name: 'Open Page Reminder 1' })
  const url = new URL(
    fetcher.mock.calls.filter(([v]) => v.startsWith(base + '?')).at(-1)![0],
    'https://example.test',
  )
  expect(url.searchParams.get('cursor')).toBeNull()
  expect(url.searchParams.get('due')).toBe('due')
  expect(url.searchParams.get('owner')).toBe('me')
  expect(url.searchParams.get('q')).toBe('%')
  expect(url.searchParams.get('limit')).toBe('25')
})
it('keeps an archived authorized client readable and withholds every mutation', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        { permission: 'clients.view', scope: 'client' as const, client_id: clientID },
      ],
    },
  }
  const { fetcher } = setup(route, session, (url) =>
    url === `/api/v1/clients/${clientID}`
      ? json({
          data: {
            id: clientID,
            name: 'Archived Client',
            legal_name: '',
            website: '',
            notes: '',
            contacts: [],
            tags: [],
            status: 'archived',
            revision: 2,
            created_at: date,
            updated_at: date,
            archived_at: date,
          },
        })
      : undefined,
  )
  await screen.findByText(/This client is archived/)
  await screen.findByRole('link', { name: 'Open Reminder Fixture' })
  expect(screen.queryByRole('link', { name: 'Create reminder' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
  expect(writeCalls(fetcher)).toHaveLength(0)
})
it('retains recorded ownership when its eligible directory fails', async () => {
  const { fetcher } = setup(
      edit,
      identity,
      (url) =>
        url.includes('/owners?') ? json({ error: { code: 'request_failed' } }, 500) : undefined,
      { ...reminder, owner_id: taskID },
    ),
    u = userEvent.setup()
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Owner')).toHaveValue(taskID)
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await screen.findByRole('heading', { name: 'Reminder Fixture' })
  expect(JSON.parse(writeCalls(fetcher)[0]![1].body).owner_id).toBe(taskID)
})
it('does not navigate from a departed route after an old mutation finishes', async () => {
  let finish: (response: Response) => void = () => undefined
  const pending = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const { fetcher } = setup(edit, identity, (_url, init) =>
      init.method === 'PUT' ? pending : undefined,
    ),
    u = userEvent.setup()
  await screen.findByDisplayValue('Reminder Fixture')
  await u.click(screen.getByRole('button', { name: 'Save reminder' }))
  await waitFor(() => expect(writeCalls(fetcher)).toHaveLength(1))
  await u.click(screen.getByRole('link', { name: 'ROISEY ELSE' }))
  await screen.findByRole('heading', { name: 'Operations workspace' })
  await act(async () => {
    finish(json({ data: { id: recordID, revision: 2 } }))
    await pending
  })
  expect(screen.getByRole('heading', { name: 'Operations workspace' })).toBeVisible()
  expect(screen.queryByText('Reminder updated.')).not.toBeInTheDocument()
})
