import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import type { RecordData } from './models'
import {
  clientID,
  date,
  identity,
  milestone,
  milestoneID,
  otherID,
  plan,
  planID,
  taskID,
} from './fixtures.test-data'
const base = `/api/v1/clients/${clientID}/plans`,
  route = `/app/clients/${clientID}/plans`,
  childRoute = route + '/' + planID + '/milestones/' + milestoneID
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
  initial: RecordData = plan,
  initialChild: RecordData = milestone,
) {
  const record = { ...initial },
    child = { ...initialChild }
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/session') return Promise.resolve(json({ data: session }))
    if (url.startsWith(base + '/' + planID + '/task-candidates?'))
      return Promise.resolve(json(page([{ id: otherID, title: 'Candidate Task', status: 'todo' }])))
    if (url.includes('/task-links?'))
      return Promise.resolve(
        json(page([{ id: otherID, task_id: taskID, linked_at: date, unlinked_at: null }])),
      )
    const isChild = url.includes('/milestones')
    if (init.method === 'GET') {
      if (url.includes('?')) return Promise.resolve(json(page([isChild ? child : record])))
      return Promise.resolve(json({ data: isChild ? child : record }))
    }
    const body = JSON.parse(init.body as string),
      r = isChild ? child : record
    if (url.endsWith('/task-links')) r.task_ids = body.task_ids
    else if (url.endsWith('/status')) {
      r.status = body.status
      r.completed_at = body.status === 'completed' ? date : null
      r.cancelled_at = body.status === 'cancelled' ? date : null
    } else if (url.endsWith('/archive')) r.archived_at = date
    else {
      const { expected_revision, ...metadata } = body
      Object.assign(r, metadata)
      if (init.method === 'POST') r.revision = 0
      void expected_revision
    }
    r.revision = body.expected_revision ? body.expected_revision + 1 : 1
    return Promise.resolve(json({ data: { id: r.id, revision: r.revision } }))
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
  return { fetcher, cache }
}
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('opens scoped planning-only views without client/task reads or write controls', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [{ permission: 'planning.view', scope: 'client' as const, client_id: clientID }],
    },
  }
  const { fetcher } = setup(route, session)
  await screen.findByRole('link', { name: 'Open Plan Fixture' }, { timeout: 5000 })
  expect(screen.queryByRole('link', { name: 'Create plan' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Edit plan' })).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(
      ([url]) => url === `/api/v1/clients/${clientID}` || url.includes('/tasks'),
    ),
  ).toBe(false)
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Planning'),
  ).toBeInTheDocument()
})
it('denies foreign-client planning before domain reads', async () => {
  const { fetcher } = setup(`/app/clients/${otherID}/plans/${planID}`)
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.every(([url]) => url === '/api/v1/auth/session')).toBe(true)
})
it('validates and creates a plan with normalized text and explicit dates', async () => {
  const { fetcher } = setup(route + '/new')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Create plan' }))
  await screen.findByText('Use 1–200 characters without control characters.')
  await u.type(screen.getByLabelText('Plan title'), ' Created Plan ')
  fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '2026-10-03T12:00' } })
  await u.click(screen.getByRole('button', { name: 'Create plan' }))
  await screen.findByRole('heading', { name: 'Created Plan' })
  const call = fetcher.mock.calls.find(([url, init]) => url === base && init.method === 'POST')!
  expect(JSON.parse(call[1].body as string)).toEqual({
    title: 'Created Plan',
    description: '',
    start_at: null,
    due_at: '2026-10-03T12:00:00.000Z',
  })
})
it('validates milestone due dates against current parent and omits start_at', async () => {
  const parent = { ...plan, start_at: '2026-10-02T12:00:00Z', due_at: '2026-10-03T12:00:00Z' }
  const { fetcher } = setup(
    route + '/' + planID + '/milestones/new',
    identity,
    () => undefined,
    parent,
  )
  const u = userEvent.setup()
  await waitFor(() => expect(screen.getByLabelText('Milestone title')).toBeEnabled())
  expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument()
  await u.type(screen.getByLabelText('Milestone title'), ' New Milestone ')
  fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '2026-10-04T12:00' } })
  await u.click(screen.getByRole('button', { name: 'Create milestone' }))
  await screen.findByText('Milestone due time must be inside the current plan date window.')
  fireEvent.change(screen.getByLabelText('Due time'), { target: { value: '2026-10-03T12:00' } })
  await u.click(screen.getByRole('button', { name: 'Create milestone' }))
  await screen.findByRole('heading', { name: 'New Milestone' })
  const call = fetcher.mock.calls.find(
    ([url, init]) => url === base + '/' + planID + '/milestones' && init.method === 'POST',
  )!
  expect(JSON.parse(call[1].body as string)).toEqual({
    title: 'New Milestone',
    description: '',
    due_at: '2026-10-03T12:00:00.000Z',
  })
})
it('preserves metadata drafts through conflicts until explicit reload', async () => {
  let conflict = false
  const { fetcher } = setup(route + '/' + planID + '/edit', identity, (url, init) => {
    if (init.method === 'PUT') {
      conflict = true
      return json({ error: { code: 'conflict' } }, 409)
    }
    if (conflict && url === base + '/' + planID && init.method === 'GET')
      return json({ data: { ...plan, title: 'Current Plan', revision: 2 } })
  })
  const u = userEvent.setup()
  await screen.findByDisplayValue('Plan Fixture')
  await u.clear(screen.getByLabelText('Plan title'))
  await u.type(screen.getByLabelText('Plan title'), 'Unsaved Draft')
  await u.click(screen.getByRole('button', { name: 'Save plan' }))
  await screen.findByText(/Your draft is preserved/)
  expect(screen.getByLabelText('Plan title')).toHaveValue('Unsaved Draft')
  expect(screen.getByRole('button', { name: 'Save plan' })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Reload current data' }))
  await screen.findByDisplayValue('Current Plan')
  expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1)
})
it('preserves drafts when a background detail refresh fails', async () => {
  let fail = false
  const { cache } = setup(route + '/' + planID + '/edit', identity, (url, init) =>
    fail && url === base + '/' + planID && init.method === 'GET'
      ? json({ error: { code: 'service_unavailable' } }, 503)
      : undefined,
  )
  await screen.findByDisplayValue('Plan Fixture')
  fireEvent.change(screen.getByLabelText('Plan title'), { target: { value: 'Kept Draft' } })
  fail = true
  await act(async () => {
    await cache.invalidateQueries({ queryKey: ['planning'] })
  })
  expect(screen.getByLabelText('Plan title')).toHaveValue('Kept Draft')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save plan' })).toBeDisabled())
  expect(screen.getByRole('alert')).toBeInTheDocument()
})
it('keeps terminal parent milestones readable while blocking changes and candidates', async () => {
  const { fetcher } = setup(childRoute, identity, () => undefined, {
    ...plan,
    status: 'completed',
    completed_at: date,
  })
  await screen.findByRole('heading', { name: 'Milestone Fixture' })
  await screen.findByText(/The parent plan is completed/)
  expect(screen.queryByRole('link', { name: 'Edit milestone' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Edit task links' })).not.toBeInTheDocument()
  expect(fetcher.mock.calls.some(([url]) => url.includes('task-candidates'))).toBe(false)
})
it('changes plan state manually and reopens without changing child or task records', async () => {
  const { fetcher } = setup(route + '/' + planID, identity, () => undefined, {
    ...plan,
    status: 'active',
  })
  const u = userEvent.setup()
  await u.selectOptions(await screen.findByLabelText('Next status for Plan Fixture'), 'completed')
  await u.click(screen.getByRole('button', { name: 'Change status of Plan Fixture' }))
  await screen.findByText('Completed', { selector: 'dt' })
  expect(screen.queryByRole('link', { name: 'Edit plan' })).not.toBeInTheDocument()
  await u.selectOptions(screen.getByLabelText('Next status for Plan Fixture'), 'active')
  await u.click(screen.getByRole('button', { name: 'Change status of Plan Fixture' }))
  await screen.findByRole('link', { name: 'Edit plan' })
  expect(
    fetcher.mock.calls
      .filter(([, init]) => init.method === 'POST')
      .every(([url]) => url === base + '/' + planID + '/status'),
  ).toBe(true)
})
it('confirms archival before writing and retains record details', async () => {
  const { fetcher } = setup(route + '/' + planID)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Archive Plan Fixture' }))
  await screen.findByRole('dialog', { name: 'Archive Plan Fixture?' })
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/archive'))).toBe(false)
  await u.click(screen.getByRole('button', { name: 'Confirm archive' }))
  await screen.findByText('Record archived.')
  expect(screen.getByText('Synthetic private plan text')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Edit plan' })).not.toBeInTheDocument()
})
it('retains or removes historical task IDs without requesting candidates or task metadata', async () => {
  const { fetcher } = setup(childRoute)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  await screen.findByText(/Task access is unavailable/)
  expect(screen.queryByRole('link', { name: 'Task ' + taskID })).not.toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Remove task reference ' + taskID }))
  await u.click(screen.getByRole('button', { name: 'Save task links' }))
  await screen.findByText('Task links saved.')
  const call = fetcher.mock.calls.find(
    ([url, init]) => url.endsWith('/task-links') && init.method === 'PUT',
  )!
  expect(JSON.parse(call[1].body as string)).toEqual({ task_ids: [], expected_revision: 1 })
  expect(
    fetcher.mock.calls.some(([url]) => url.includes('task-candidates') || url.includes('/tasks/')),
  ).toBe(false)
})
it('preserves selected candidates through conflicts and reloads only by explicit action', async () => {
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
  let stale = false
  setup(childRoute, session, (url, init) => {
    if (url.endsWith('/task-links') && init.method === 'PUT') {
      stale = true
      return json({ error: { code: 'conflict' } }, 409)
    }
    if (
      stale &&
      url === base + '/' + planID + '/milestones/' + milestoneID &&
      init.method === 'GET'
    )
      return json({ data: { ...milestone, revision: 2, task_ids: [] } })
  })
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  await u.click(await screen.findByRole('checkbox', { name: /Candidate Task/ }))
  await u.click(screen.getByRole('button', { name: 'Save task links' }))
  await screen.findByText(/Your selection is preserved/)
  expect(screen.getByRole('checkbox', { name: /Candidate Task/ })).toBeChecked()
  expect(screen.getByRole('button', { name: 'Save task links' })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Reload task references' }))
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /Candidate Task/ })).not.toBeChecked(),
  )
  expect(screen.getByText('No task references selected.')).toBeInTheDocument()
})
it('refreshes revoked planning grants and removes domain data', async () => {
  const { cache } = setup(route)
  await screen.findByRole('link', { name: 'Open Plan Fixture' })
  await act(async () => {
    cache.setQueryData(sessionKey, {
      session: { ...identity, user: { ...identity.user, permissions: [] } },
      expired: false,
    })
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText('Plan Fixture')).not.toBeInTheDocument()
})
it('does not navigate after a late mutation response from an unmounted route', async () => {
  let finish!: (r: Response) => void
  setup(route + '/new', identity, (url, init) =>
    url === base && init.method === 'POST'
      ? new Promise<Response>((r) => {
          finish = r
        })
      : undefined,
  )
  const u = userEvent.setup()
  await u.type(await screen.findByLabelText('Plan title'), 'Leaving Draft')
  await u.click(screen.getByRole('button', { name: 'Create plan' }))
  await u.click(screen.getByRole('link', { name: 'Cancel' }))
  await screen.findByRole('link', { name: 'Open Plan Fixture' })
  await act(async () => {
    finish(json({ data: { id: planID, revision: 1 } }))
  })
  expect(screen.queryByRole('heading', { name: 'Leaving Draft' })).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Open Plan Fixture' })).toBeInTheDocument()
})
it('shows safe errors and bounded empty states', async () => {
  setup(route, identity, (url) => (url.startsWith(base + '?') ? json(page([])) : undefined))
  await screen.findByRole('heading', { name: 'No plans on this page' })
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})
it('preserves UTC microseconds when metadata dates are unchanged', async () => {
  const original = '2026-10-02T12:00:00.123456Z'
  const { fetcher } = setup(route + '/' + planID + '/edit', identity, () => undefined, {
    ...plan,
    start_at: original,
  })
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Save plan' }))
  await screen.findByText('Record updated.')
  const call = fetcher.mock.calls.find(([, init]) => init.method === 'PUT')!
  expect(JSON.parse(call[1].body as string).start_at).toBe(original)
})
it('discards cached task titles on a grant change while retaining reference IDs', async () => {
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
  const { cache } = setup(childRoute, session)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  await screen.findByText('Candidate Task')
  await act(async () => {
    cache.setQueryData(sessionKey, { session: identity, expired: false })
  })
  await screen.findByText(/Task access is unavailable/)
  expect(screen.queryByText('Candidate Task')).not.toBeInTheDocument()
  expect(screen.getByText('Task reference ' + taskID)).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Task ' + taskID })).not.toBeInTheDocument()
})
it('preserves new selections after task access is revoked and requires their removal before saving', async () => {
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
  const { cache, fetcher } = setup(childRoute, session)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  await u.click(await screen.findByRole('checkbox', { name: /Candidate Task/ }))
  await act(async () => {
    cache.setQueryData(sessionKey, { session: identity, expired: false })
  })
  await screen.findByText(/Remove new selections before saving/)
  expect(screen.queryByText('Candidate Task')).not.toBeInTheDocument()
  expect(screen.getByText('Task reference ' + otherID)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save task links' })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Remove task reference ' + otherID }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save task links' })).toBeEnabled())
  await u.click(screen.getByRole('button', { name: 'Save task links' }))
  await screen.findByText('Task links saved.')
  const call = fetcher.mock.calls.find(
    ([url, init]) => url.endsWith('/task-links') && init.method === 'PUT',
  )!
  expect(JSON.parse(call[1].body as string)).toEqual({ task_ids: [taskID], expected_revision: 1 })
})
it('keeps selections during candidate paging errors and resets the cursor when searching', async () => {
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
  let fail = true
  const { fetcher } = setup(childRoute, session, (url) => {
    if (!url.includes('/task-candidates?')) return undefined
    const params = new URL(url, 'http://fixture.test').searchParams
    if (params.has('cursor'))
      return fail ? json({ error: { code: 'service_unavailable' } }, 503) : json(page([]))
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      id: index === 24 ? otherID : `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
      title: index === 24 ? 'Candidate Task' : `Other fixture ${index}`,
      status: 'todo',
    }))
    return json(page(candidates, otherID))
  })
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  await u.click(await screen.findByRole('checkbox', { name: /Candidate Task/ }))
  const pager = screen.getByRole('navigation', { name: 'Task candidates pagination' })
  await u.click(within(pager).getByRole('button', { name: 'Next' }))
  await screen.findByRole('button', { name: 'Try again' })
  expect(screen.getByRole('list', { name: 'Task references' })).toHaveTextContent(otherID)
  fail = false
  await u.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByText('No eligible tasks on this page.')
  await u.type(screen.getByLabelText('Search task candidates'), 'literal %')
  await u.click(screen.getByRole('button', { name: 'Search tasks' }))
  await screen.findByRole('checkbox', { name: /Candidate Task/ })
  expect(screen.getByRole('checkbox', { name: /Candidate Task/ })).toBeChecked()
  const latest = fetcher.mock.calls.filter(([url]) => url.includes('/task-candidates?')).at(-1)![0]
  const params = new URL(latest, 'http://fixture.test').searchParams
  expect(params.get('q')).toBe('literal %')
  expect(params.has('cursor')).toBe(false)
})
it('enforces the 50-reference limit while allowing explicit removals', async () => {
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
  const references = Array.from(
    { length: 50 },
    (_, index) => `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
  )
  setup(childRoute, session, () => undefined, plan, { ...milestone, task_ids: references })
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit task links' }))
  expect(await screen.findByRole('checkbox', { name: /Candidate Task/ })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Remove task reference ' + references[0] }))
  await u.click(screen.getByRole('checkbox', { name: /Candidate Task/ }))
  expect(screen.getByRole('checkbox', { name: /Candidate Task/ })).toBeChecked()
  expect(
    within(screen.getByRole('list', { name: 'Task references' })).getAllByRole('listitem'),
  ).toHaveLength(50)
})
