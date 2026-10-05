import { afterEach, expect, it, vi } from 'vitest'
import {
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
import type { Session } from '../auth/session'
import { sessionKey } from '../auth/session'
import type { Task } from './models'
import {
  clientID,
  date,
  identity,
  otherID,
  task,
  taskID,
} from './fixtures.test-data'

const base = `/api/v1/clients/${clientID}/tasks`,
  route = `/app/clients/${clientID}/tasks`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const page = (data: unknown[], next_cursor: string | null = null) => ({
  data,
  page: { limit: 25, next_cursor },
})
type Override = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response> | undefined
function setup(
  path = route,
  session: Session = identity,
  override: Override = () => undefined,
  initial: Task = task,
) {
  let record = { ...initial }
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: session }))
    if (url === `/api/v1/clients/${clientID}`)
      return Promise.resolve(
        json({
          data: {
            id: clientID,
            name: 'Client Fixture',
            legal_name: '',
            status: 'active',
            revision: 1,
            tags: [],
            website: '',
            notes: '',
            contacts: [],
            created_at: date,
            updated_at: date,
            archived_at: null,
          },
        }),
      )
    if (url.startsWith(base + '/assignees?'))
      return Promise.resolve(json(page([])))
    if (url.startsWith(base + '?')) return Promise.resolve(json(page([record])))
    if (url === base + '/' + taskID && init.method === 'GET')
      return Promise.resolve(json({ data: record }))
    const body = JSON.parse((init.body as string) ?? '{}')
    if (init.method === 'PUT') {
      const { expected_revision, ...metadata } = body
      record = { ...record, ...metadata, revision: expected_revision + 1 }
    }
    if (url === base && init.method === 'POST')
      record = { ...record, ...body, revision: 1 }
    if (url.endsWith('/status'))
      record = {
        ...record,
        status: body.status,
        completed_at: body.status === 'done' ? date : null,
        cancelled_at: body.status === 'cancelled' ? date : null,
        revision: body.expected_revision + 1,
      }
    if (url.endsWith('/archive'))
      record = {
        ...record,
        archived_at: date,
        revision: body.expected_revision + 1,
      }
    return Promise.resolve(
      json({ data: { id: taskID, revision: record.revision } }),
    )
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

it('supports task-only scoped viewing without client-profile reads or write controls', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        {
          permission: 'tasks.view',
          scope: 'client' as const,
          client_id: clientID,
        },
      ],
    },
  }
  const { fetcher } = setup(route, session)
  await screen.findByRole(
    'link',
    { name: 'Open Task Fixture' },
    { timeout: 5_000 },
  )
  expect(
    screen.queryByRole('link', { name: 'Create task' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Edit task' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Archive Task Fixture' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.some(([url]) => url === `/api/v1/clients/${clientID}`),
  ).toBe(false)
  expect(fetcher.mock.calls.some(([url]) => url.includes('/assignees'))).toBe(
    false,
  )
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
      'Tasks',
    ),
  ).toBeInTheDocument()
})
it('denies wrong-client task routes before any domain read', async () => {
  const { fetcher } = setup(`/app/clients/${otherID}/tasks/${taskID}`)
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === '/api/v1/auth/session' || url === '/api/v1/auth/preferences',
    ),
  ).toBe(true)
})
it('keeps legacy manage compatible while task view stays required', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: ['tasks.view', 'tasks.manage'].map((permission) => ({
        permission,
        scope: 'client' as const,
        client_id: clientID,
      })),
    },
  }
  setup(route, session)
  await screen.findByRole('link', { name: 'Open Task Fixture' })
  expect(screen.getByRole('link', { name: 'Create task' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Edit task' })).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Archive Task Fixture' }),
  ).toBeInTheDocument()
})
it('validates and creates normalized metadata with explicit dates and initial state', async () => {
  const { fetcher } = setup(route + '/new')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Create task' }))
  await screen.findByText('Use 1–200 characters without control characters.')
  expect(fetcher.mock.calls.some(([, init]) => init.method === 'POST')).toBe(
    false,
  )
  await u.type(screen.getByLabelText('Task title'), ' Created Task ')
  await u.type(screen.getByLabelText('Description'), 'Line one\nLine two')
  await u.type(screen.getByLabelText('Tags', { exact: true }), 'WORK\nwork')
  await u.click(screen.getByRole('button', { name: 'Create task' }))
  await screen.findByText('Tags must be distinct after normalization.')
  await u.clear(screen.getByLabelText('Tags', { exact: true }))
  await u.type(screen.getByLabelText('Tags', { exact: true }), 'WORK')
  fireEvent.change(screen.getByLabelText('Start time'), {
    target: { value: '2026-10-02T12:00' },
  })
  fireEvent.change(screen.getByLabelText('Due time'), {
    target: { value: '2026-10-02T11:00' },
  })
  await u.click(screen.getByRole('button', { name: 'Create task' }))
  await screen.findByText('Due time must not precede start time.')
  fireEvent.change(screen.getByLabelText('Due time'), {
    target: { value: '2026-10-02T13:00' },
  })
  await u.selectOptions(screen.getByLabelText('Initial status'), 'backlog')
  await u.click(screen.getByRole('button', { name: 'Create task' }))
  await screen.findByText('Task created.')
  const body = JSON.parse(
    fetcher.mock.calls.find(([, init]) => init.method === 'POST')![1]
      .body as string,
  )
  expect(body).toMatchObject({
    title: 'Created Task',
    description: 'Line one\nLine two',
    tags: ['work'],
    status: 'backlog',
    assignee_id: null,
  })
  expect(Date.parse(body.due_at) - Date.parse(body.start_at)).toBe(3_600_000)
  expect(body).not.toHaveProperty('created_by')
  expect(body).not.toHaveProperty('completed_at')
})
it('preserves stale drafts and historical assignees until explicit reload/discard', async () => {
  let reads = 0,
    writes = 0
  const original = {
    ...task,
    assignee_id: otherID,
    start_at: '2026-10-02T00:00:00.123456Z',
    due_at: '2026-10-03T00:00:00.987654Z',
  }
  const { fetcher } = setup(
    route + '/' + taskID + '/edit',
    identity,
    (url, init) => {
      if (url === base + '/' + taskID && init.method === 'GET')
        return json({
          data: {
            ...original,
            title: ++reads === 1 ? 'Task Fixture' : 'Current Task',
            revision: reads === 1 ? 1 : writes > 1 ? 3 : 2,
          },
        })
      if (init.method === 'PUT')
        return ++writes === 1
          ? json({ error: { code: 'conflict' } }, 409)
          : json({ data: { id: taskID, revision: 3 } })
    },
    original,
  )
  const u = userEvent.setup()
  await screen.findByDisplayValue('Task Fixture')
  await u.clear(screen.getByLabelText('Task title'))
  await u.type(screen.getByLabelText('Task title'), 'Preserved draft')
  await u.click(screen.getByRole('button', { name: 'Save task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('record changed')
  expect(screen.getByLabelText('Task title')).toHaveValue('Preserved draft')
  expect(screen.getByRole('button', { name: 'Save task' })).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Reload current data' }))
  await screen.findByDisplayValue('Current Task')
  await u.click(screen.getByRole('button', { name: 'Save task' }))
  await screen.findByText('Task updated.')
  const body = JSON.parse(
    fetcher.mock.calls.filter(([, init]) => init.method === 'PUT').at(-1)![1]
      .body as string,
  )
  expect(body).toMatchObject({
    expected_revision: 2,
    assignee_id: otherID,
    start_at: original.start_at,
    due_at: original.due_at,
  })
  expect(
    fetcher.mock.calls.some(([url]) => url === `/api/v1/clients/${clientID}`),
  ).toBe(false)
})
it('completes and explicitly reopens tasks using confirmed server state', async () => {
  const { fetcher } = setup(route + '/' + taskID, identity, () => undefined, {
    ...task,
    status: 'in_progress',
  })
  const u = userEvent.setup()
  await screen.findByRole('heading', { name: 'Task Fixture' })
  await u.selectOptions(
    screen.getByLabelText('Next status for Task Fixture'),
    'done',
  )
  await u.click(
    screen.getByRole('button', { name: 'Change status of Task Fixture' }),
  )
  await screen.findByText('Done', { selector: '.ui-status' })
  expect(
    screen.queryByRole('link', { name: 'Edit task' }),
  ).not.toBeInTheDocument()
  expect(screen.getByText('Completed', { selector: 'dt' })).toBeInTheDocument()
  await u.selectOptions(
    screen.getByLabelText('Next status for Task Fixture'),
    'in_progress',
  )
  await u.click(
    screen.getByRole('button', { name: 'Change status of Task Fixture' }),
  )
  await screen.findByRole('link', { name: 'Edit task' })
  expect(
    screen.queryByText('Completed', { selector: 'dt' }),
  ).not.toBeInTheDocument()
  const requests = fetcher.mock.calls.filter(([url]) => url.endsWith('/status'))
  expect(requests.map(([, init]) => JSON.parse(init.body as string))).toEqual([
    { status: 'done', expected_revision: 1 },
    { status: 'in_progress', expected_revision: 2 },
  ])
})
it('shows rejected-transition feedback and requires reload before another choice', async () => {
  let writes = 0
  setup(route + '/' + taskID, identity, (url, init) =>
    url.endsWith('/status') && init.method === 'POST'
      ? ++writes === 1
        ? json(
            { error: { code: 'invalid_transition', message: 'private state' } },
            409,
          )
        : undefined
      : undefined,
  )
  const u = userEvent.setup()
  await screen.findByRole('heading', { name: 'Task Fixture' })
  await u.selectOptions(
    screen.getByLabelText('Next status for Task Fixture'),
    'in_progress',
  )
  await u.click(
    screen.getByRole('button', { name: 'Change status of Task Fixture' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'status transition is no longer available',
  )
  expect(screen.getByRole('alert')).not.toHaveTextContent('private state')
  expect(
    screen.getByRole('button', { name: 'Change status of Task Fixture' }),
  ).toBeDisabled()
  await u.click(screen.getByRole('button', { name: 'Reload current task' }))
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
  )
  expect(screen.getByLabelText('Next status for Task Fixture')).toHaveValue('')
})
it('confirms archival of the captured revision and keeps readable history', async () => {
  const { fetcher } = setup(route + '/' + taskID)
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', { name: 'Archive Task Fixture' }),
  )
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/archive'))).toBe(
    false,
  )
  await u.click(screen.getByRole('button', { name: 'Confirm archive' }))
  await screen.findByText('Task archived.')
  expect(screen.getByText(/Private fixture description/)).toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Edit task' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Archive Task Fixture' }),
  ).not.toBeInTheDocument()
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([url]) => url.endsWith('/archive'))![1]
        .body as string,
    ),
  ).toEqual({ confirm: true, expected_revision: 1 })
})
it('withholds stale private rows on errors and supports retry into an empty list', async () => {
  let reads = 0
  setup(route, identity, (url) =>
    url.startsWith(base + '?')
      ? ++reads === 1
        ? json(
            { error: { code: 'internal_error', message: 'private task text' } },
            500,
          )
        : json(page([]))
      : undefined,
  )
  expect(await screen.findByRole('alert')).not.toHaveTextContent(
    'private task text',
  )
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('heading', { name: 'No tasks on this page' })
  expect(
    screen.queryByRole('table', { name: 'Client tasks' }),
  ).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})
it('uses server cursor history and resets it when filters change', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    ...task,
    id: `50000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    title: `Task Page ${i + 1}`,
  }))
  const last = entries.at(-1)!.id
  const { fetcher } = setup(route, identity, (url) =>
    url.startsWith(base + '?')
      ? new URL(url, 'http://localhost').searchParams.has('cursor')
        ? json(page([{ ...task, title: 'Second Page Task' }]))
        : json(page(entries, last))
      : undefined,
  )
  const u = userEvent.setup()
  await screen.findByRole('link', { name: 'Open Task Page 1' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('link', { name: 'Open Second Page Task' })
  await u.type(screen.getByLabelText('Search task titles'), '100%')
  await u.selectOptions(screen.getByLabelText('Task status'), 'done')
  await u.selectOptions(screen.getByLabelText('Records'), 'all')
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled(),
  )
  const query = new URL(
    fetcher.mock.calls.filter(([url]) => url.startsWith(base + '?')).at(-1)![0],
    'http://localhost',
  ).searchParams
  expect(query.get('cursor')).toBeNull()
  expect(query.get('q')).toBe('100%')
  expect(query.get('status')).toBe('done')
  expect(query.get('archived')).toBe('all')
})
it('keeps archived parents read-only when authorized client context is available', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        {
          permission: 'clients.view',
          scope: 'client' as const,
          client_id: clientID,
        },
      ],
    },
  }
  setup(route, session, (url) =>
    url === `/api/v1/clients/${clientID}`
      ? json({
          data: {
            id: clientID,
            name: 'Archived Client',
            legal_name: '',
            status: 'archived',
            revision: 2,
            tags: [],
            website: '',
            notes: '',
            contacts: [],
            created_at: date,
            updated_at: date,
            archived_at: date,
          },
        })
      : undefined,
  )
  await screen.findByRole('link', { name: 'Open Task Fixture' })
  await screen.findByText(/This client is archived/)
  expect(
    screen.queryByRole('link', { name: 'Create task' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Edit task' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Archive Task Fixture' }),
  ).not.toBeInTheDocument()
})
it('clears task content and private queries when the session expires', async () => {
  let reads = 0
  const { cache } = setup(route, identity, (url) =>
    url === '/api/v1/auth/session'
      ? ++reads === 1
        ? json({ data: identity })
        : json({ error: { code: 'authentication_required' } }, 401)
      : url.startsWith(base + '?')
        ? json({ error: { code: 'authentication_required' } }, 401)
        : undefined,
  )
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(
    cache
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey[0] === 'tasks'),
  ).toBe(false)
})
it('refreshes revoked task grants after denial without leaving private task content', async () => {
  let reads = 0
  setup(route, identity, (url) =>
    url === '/api/v1/auth/session'
      ? json({
          data:
            ++reads === 1
              ? identity
              : { ...identity, user: { ...identity.user, permissions: [] } },
        })
      : url.startsWith(base + '?')
        ? json({ error: { code: 'not_found' } }, 404)
        : undefined,
  )
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText('Task Fixture')).not.toBeInTheDocument()
})
it('discards late task responses after grants change while retaining current authorized data', async () => {
  let current = identity,
    reads = 0
  let finish: (response: Response) => void = () => {
    throw new Error('Request not started')
  }
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve
  })
  const { cache } = setup(route, identity, (url) =>
    url === '/api/v1/auth/session'
      ? json({ data: current })
      : url.startsWith(base + '?')
        ? ++reads === 1
          ? delayed
          : json(page([{ ...task, title: 'Current authorized task' }]))
        : undefined,
  )
  await screen.findByText('Loading tasks…')
  current = {
    ...identity,
    user: { ...identity.user, permissions: [identity.user.permissions[0]!] },
  }
  cache.setQueryData(sessionKey, { session: current, expired: false })
  await screen.findByRole('link', { name: 'Open Current authorized task' })
  finish(json(page([{ ...task, title: 'Late private task' }])))
  await waitFor(() =>
    expect(
      cache
        .getQueryCache()
        .getAll()
        .some((q) => q.state.fetchStatus === 'fetching'),
    ).toBe(false),
  )
  expect(screen.queryByText('Late private task')).not.toBeInTheDocument()
  expect(
    JSON.stringify(cache.getQueriesData({ queryKey: ['tasks'] })),
  ).not.toContain('Late private task')
})
it('preserves an unsaved draft while optional client context is checked again', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        {
          permission: 'clients.view',
          scope: 'client' as const,
          client_id: clientID,
        },
      ],
    },
  }
  const { cache } = setup(route + '/' + taskID + '/edit', session)
  const u = userEvent.setup()
  await u.clear(await screen.findByLabelText('Task title'))
  await u.type(screen.getByLabelText('Task title'), 'Unsaved task draft')
  await cache.invalidateQueries({
    predicate: (q) => q.queryKey.includes('client-context'),
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save task' })).toBeEnabled(),
  )
  expect(screen.getByLabelText('Task title')).toHaveValue('Unsaved task draft')
})
it('pages eligible assignees while preserving a selection absent from another page', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `50000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      display_name: `Eligible ${i + 1}`,
    })),
    selected = '60000000-0000-4000-8000-000000000001'
  const { fetcher } = setup(
    route + '/' + taskID + '/edit',
    identity,
    (url) =>
      url.startsWith(base + '/assignees?')
        ? new URL(url, 'http://localhost').searchParams.has('cursor')
          ? json(page([{ id: selected, display_name: 'Second page assignee' }]))
          : json(page(entries, entries.at(-1)!.id))
        : undefined,
    { ...task, assignee_id: otherID },
  )
  const u = userEvent.setup()
  await screen.findByRole('option', { name: 'Eligible 1' })
  expect(screen.getByLabelText('Assignee')).toHaveValue(otherID)
  await u.click(screen.getByRole('button', { name: 'Next assignees' }))
  await screen.findByRole('option', { name: 'Second page assignee' })
  await u.selectOptions(screen.getByLabelText('Assignee'), selected)
  await u.click(screen.getByRole('button', { name: 'Previous assignees' }))
  await screen.findByRole('option', { name: 'Eligible 1' })
  expect(screen.getByLabelText('Assignee')).toHaveValue(selected)
  await u.click(screen.getByRole('button', { name: 'Save task' }))
  await screen.findByText('Task updated.')
  expect(
    JSON.parse(
      fetcher.mock.calls.find(([, init]) => init.method === 'PUT')![1]
        .body as string,
    ).assignee_id,
  ).toBe(selected)
})
