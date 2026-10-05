import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import type { Client } from './models'
import type { Session } from '../auth/session'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const date = '2026-10-01T00:00:00Z'
const record: Client = {
  id,
  name: 'Client Fixture',
  legal_name: '',
  status: 'active',
  revision: 1,
  tags: ['fixture'],
  website: '',
  notes: '',
  contacts: [{ name: 'Contact Fixture', email: 'contact@example.com', phone: '' }],
  created_at: date,
  updated_at: date,
  archived_at: null,
}
const identity: Session = {
  user: {
    id: other,
    email: 'actor@example.com',
    display_name: 'Actor Fixture',
    permissions: ['clients.create', 'clients.view', 'clients.update', 'clients.archive'].map(
      (permission) => ({ permission, scope: 'global' }),
    ),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const page = (data: unknown[]) => ({ data, page: { limit: 25, next_cursor: null } })
type Override = (path: string, init: RequestInit) => Response | Promise<Response> | undefined
function setup(path = '/app/clients', session = identity, override: Override = () => undefined) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/session') return Promise.resolve(json({ data: session }))
    if (url.startsWith('/api/v1/clients?')) return Promise.resolve(json(page([record])))
    if (url === `/api/v1/clients/${id}` && init?.method === 'GET')
      return Promise.resolve(json({ data: record }))
    if (url === `/api/v1/clients/${id}/overview`)
      return Promise.resolve(json({ data: { client: {id,name:record.name,status:'active',archived_at:null},as_of:date,horizon_end:'2026-10-08T00:00:00Z' } }))
    return Promise.resolve(
      json({
        data: { id, revision: init?.method === 'POST' && url === '/api/v1/clients' ? 1 : 2 },
      }),
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

it('denies wrong-client deep links before fetching with a scoped view grant', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [{ permission: 'clients.view', scope: 'client' as const, client_id: id }],
    },
  }
  const { fetcher } = setup(`/app/clients/${other}`, session)
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.every(([path]) => path === '/api/v1/auth/session')).toBe(true)
  expect(
    within(screen.getByRole('navigation', { name: 'Application' })).getByRole('link', {
      name: 'Clients',
    }),
  ).toBeInTheDocument()
})
it('keeps create-only users out of collection/detail reads and confirms separately assigned access', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [{ permission: 'clients.create', scope: 'global' as const }],
    },
  }
  const { fetcher } = setup('/app/clients', session)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('link', { name: 'Create client' }))
  await u.type(await screen.findByLabelText('Client name'), 'Created Fixture')
  await u.click(screen.getByRole('button', { name: 'Create client' }))
  await screen.findByText('Client created. Access is assigned separately through roles.')
  expect(
    fetcher.mock.calls.some(
      ([path, init]) => path.startsWith('/api/v1/clients') && init?.method === 'GET',
    ),
  ).toBe(false)
  expect(screen.queryByRole('table', { name: 'Clients' })).not.toBeInTheDocument()
})
it('refreshes revoked grants after a denied read and removes all private client content', async () => {
  let identities = 0
  setup('/app/clients', identity, (path) => {
    if (path === '/api/v1/auth/session')
      return json({
        data:
          ++identities === 1
            ? identity
            : { ...identity, user: { ...identity.user, permissions: [] } },
      })
    if (path.startsWith('/api/v1/clients?'))
      return json({ error: { code: 'permission_denied' } }, 403)
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument()
  expect(screen.queryByText('Client Fixture')).not.toBeInTheDocument()
})
it('handles loading, safe failure, retry and empty client pages', async () => {
  let release: (response: Response) => void = () => {}
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  let reads = 0
  setup('/app/clients', identity, (path) =>
    path.startsWith('/api/v1/clients?') ? (++reads === 1 ? pending : json(page([]))) : undefined,
  )
  await screen.findByText('Loading clients…')
  release(json({ error: { code: 'internal_error', message: 'private contact' } }, 500))
  expect(await screen.findByRole('alert')).not.toHaveTextContent('private contact')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('heading', { name: 'No clients on this page' })
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})
it('uses server cursors in both directions and resets them when applying API filters', async () => {
  const { fetcher } = setup('/app/clients', identity, (path) => {
    if (path.startsWith('/api/v1/clients?')) {
      const query = new URL(path, 'http://localhost').searchParams
      return query.has('cursor')
        ? json(page([{ ...record, id: other, name: 'Next Fixture' }]))
        : json({ data: [record], page: { limit: 25, next_cursor: id } })
    }
  })
  const u = userEvent.setup()
  await screen.findByRole('link', { name: 'Open Client Fixture' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('link', { name: 'Open Next Fixture' })
  await u.click(screen.getByRole('button', { name: 'Previous' }))
  await screen.findByRole('link', { name: 'Open Client Fixture' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('link', { name: 'Open Next Fixture' })
  await u.type(screen.getByLabelText('Search by name'), '100%')
  await u.type(screen.getByLabelText('Tag'), 'TAG')
  await u.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'all')
  await u.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), '-id')
  await u.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled())
  const query = new URL(
    fetcher.mock.calls.filter(([p]) => p.startsWith('/api/v1/clients?')).at(-1)![0],
    'http://localhost',
  ).searchParams
  expect(Object.fromEntries(query)).toEqual({
    limit: '25',
    status: 'all',
    sort: '-id',
    q: '100%',
    tag: 'tag',
  })
})
it('shows no mutation controls to a scoped viewer and keeps unavailable modules non-actionable', async () => {
  setup(`/app/clients/${id}/profile`, {
    ...identity,
    user: {
      ...identity.user,
      permissions: [{ permission: 'clients.view', scope: 'client', client_id: id }],
    },
  })
  await screen.findByRole('heading', { name: 'Client Fixture' })
  expect(screen.queryByRole('link', { name: 'Edit client' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Archive client' })).not.toBeInTheDocument()
  const modules = within(screen.getByRole('navigation', { name: 'Client modules' }))
  expect(modules.queryByRole('link', { name: 'Marketing' })).not.toBeInTheDocument()
  expect(modules.getByRole('link', {name:'Overview'})).toBeInTheDocument()
  expect(modules.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page')
  expect(modules.queryAllByRole('link')).toHaveLength(2)
})
it('validates form fields, contacts and tags before sending normalized creation', async () => {
  const { fetcher } = setup('/app/clients/new')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Create client' }))
  await screen.findByText('Use 1–200 characters without control characters.')
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  await u.type(screen.getByLabelText('Client name'), ' New Fixture ')
  await u.type(screen.getByLabelText('Tags', { exact: true }), 'TAG\ntag')
  await u.click(screen.getByRole('button', { name: 'Add contact' }))
  await u.click(screen.getByRole('button', { name: 'Create client' }))
  await screen.findByText('Tags must be distinct after normalization.')
  await screen.findByText('Use 1–100 characters without control characters.')
  await u.clear(screen.getByLabelText('Tags', { exact: true }))
  await u.type(screen.getByLabelText('Tags', { exact: true }), 'TAG')
  await u.type(screen.getByLabelText('Contact 1 name'), ' Contact ')
  await u.type(screen.getByLabelText('Contact 1 email'), 'MAIL@EXAMPLE.COM')
  await u.click(screen.getByRole('button', { name: 'Create client' }))
  await screen.findByText('Client created.')
  const request = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(request[1]?.body as string)).toMatchObject({
    name: 'New Fixture',
    tags: ['tag'],
    contacts: [{ name: 'Contact', email: 'mail@example.com', phone: '' }],
  })
})
it('preserves stale drafts until explicit reload and replaces contacts using the refreshed revision', async () => {
  let writes = 0
  let reads = 0
  const { fetcher } = setup(`/app/clients/${id}/edit`, identity, (path, init) => {
    if (path === `/api/v1/clients/${id}` && init?.method === 'GET')
      return json({
        data: ++reads === 1 ? record : { ...record, name: 'Current Fixture', revision: 2 },
      })
    if (init?.method === 'PUT')
      return ++writes === 1
        ? json({ error: { code: 'conflict' } }, 409)
        : json({ data: { id, revision: 3 } })
  })
  const u = userEvent.setup()
  await screen.findByDisplayValue('Client Fixture')
  await u.clear(screen.getByLabelText('Client name'))
  await u.type(screen.getByLabelText('Client name'), 'Draft Fixture')
  await u.click(screen.getByRole('button', { name: 'Save client' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('record changed')
  expect(screen.getByLabelText('Client name')).toHaveValue('Draft Fixture')
  await u.click(screen.getByRole('button', { name: 'Reload current data' }))
  await screen.findByDisplayValue('Current Fixture')
  await u.click(screen.getByRole('button', { name: 'Remove contact 1' }))
  await u.click(screen.getByRole('button', { name: 'Save client' }))
  await screen.findByText('Client updated.')
  const request = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!
  expect(JSON.parse(request[1]?.body as string)).toMatchObject({
    expected_revision: 2,
    contacts: [],
  })
})
it('requires deliberate archive confirmation and retains archived readable history', async () => {
  let archived = false
  const { fetcher } = setup(`/app/clients/${id}/profile`, identity, (path) => {
    if (path.endsWith('/archive')) {
      archived = true
      return json({ data: { id, revision: 2 } })
    }
    if (path === `/api/v1/clients/${id}`)
      return json({
        data: archived ? { ...record, status: 'archived', revision: 2, archived_at: date } : record,
      })
  })
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Archive client' }))
  expect(fetcher.mock.calls.some(([path]) => path.endsWith('/archive'))).toBe(false)
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await u.click(screen.getByRole('button', { name: 'Confirm archive' }))
  await screen.findByText('Client archived.')
  expect(screen.getByText('Contact Fixture')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Edit client' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Archive client' })).not.toBeInTheDocument()
  const request = fetcher.mock.calls.find(([path]) => path.endsWith('/archive'))!
  expect(JSON.parse(request[1]?.body as string)).toEqual({ expected_revision: 1, confirm: true })
})

it('clears client queries and returns to sign-in when the real session expires', async () => {
  let identities = 0
  const { cache } = setup('/app/clients', identity, (path) => {
    if (path === '/api/v1/auth/session')
      return ++identities === 1
        ? json({ data: identity })
        : json({ error: { code: 'authentication_required' } }, 401)
    if (path.startsWith('/api/v1/clients?'))
      return json({ error: { code: 'authentication_required' } }, 401)
  })
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(screen.queryByRole('table', { name: 'Clients' })).not.toBeInTheDocument()
  expect(
    cache
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey[0] === 'clients'),
  ).toBe(false)
})

it('does not reuse a cached client list after grants shrink within the same identity', async () => {
  let reduced = false
  let reads = 0
  setup('/app/clients', identity, (path) => {
    if (path === '/api/v1/auth/session')
      return json({
        data: reduced
          ? {
              ...identity,
              user: {
                ...identity.user,
                permissions: [{ permission: 'clients.view', scope: 'client', client_id: id }],
              },
            }
          : identity,
      })
    if (path.startsWith('/api/v1/clients?')) {
      reads++
      return json(
        page(
          reduced ? [record] : [record, { ...record, id: other, name: 'Other Private Fixture' }],
        ),
      )
    }
  })
  const u = userEvent.setup()
  await screen.findByRole('link', { name: 'Open Other Private Fixture' })
  await u.click(
    within(screen.getByRole('navigation', { name: 'Application' })).getByRole('link', {
      name: 'My access',
    }),
  )
  reduced = true
  await u.click(await screen.findByRole('button', { name: 'Refresh access' }))
  await waitFor(() => expect(screen.getByRole('table', { name: 'Your effective permissions' })).toHaveTextContent(id))
  await u.click(
    within(screen.getByRole('navigation', { name: 'Application' })).getByRole('link', {
      name: 'Clients',
    }),
  )
  await screen.findByRole('link', { name: 'Open Client Fixture' })
  expect(screen.queryByRole('link', { name: 'Open Other Private Fixture' })).not.toBeInTheDocument()
  expect(reads).toBe(2)
})

it('withholds archive success after conflict and requires cancellation before another review', async () => {
  setup('/app/clients/' + id + '/profile', identity, (path) =>
    path.endsWith('/archive') ? json({ error: { code: 'conflict' } }, 409) : undefined,
  )
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Archive client' }))
  await u.click(screen.getByRole('button', { name: 'Confirm archive' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('record changed')
  expect(screen.getByRole('button', { name: 'Confirm archive' })).toBeDisabled()
  expect(screen.queryByText('Client archived.')).not.toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
