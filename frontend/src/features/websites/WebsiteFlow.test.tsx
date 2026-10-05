import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import type { Session } from '../auth/session'
import type { Website } from './service'

const clientID = '11111111-1111-4111-8111-111111111111'
const websiteID = '22222222-2222-4222-8222-222222222222'
const otherID = '33333333-3333-4333-8333-333333333333'
const timestamp = '2026-10-01T00:00:00Z'
const website: Website = {
  id: websiteID,
  client_id: clientID,
  name: 'Clients',
  url: 'https://shop.example.com/catalog',
  domain: 'shop.example.com',
  description: 'Synthetic customer content',
  status: 'active',
  is_primary: false,
  needs_review: false,
  revision: 1,
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: null,
}
const client = {
  id: clientID,
  name: 'Synthetic account',
  legal_name: '',
  status: 'active',
  revision: 1,
  website: 'legacy value retained',
  tags: [],
  notes: '',
  contacts: [],
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: null,
}
const identity: Session = {
  user: {
    id: otherID,
    email: 'website.fixture@example.com',
    display_name: 'Synthetic reviewer',
    permissions: [
      'clients.view',
      'clients.update',
      'clients.archive',
      'analytics.view',
      'activity.view',
      'integrations.view',
      'integrations.manage',
    ].map((permission) => ({ permission, scope: 'global' })),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
const page = (data: unknown[]) => ({
  data,
  page: { limit: 25, next_cursor: null },
})
const base = `/api/v1/clients/${clientID}`
function setup(path: string, session = identity, record = website) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, options: RequestInit = {}) => {
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: session }))
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (options?.method === 'POST')
      return Promise.resolve(json({ data: { id: websiteID, revision: 2 } }))
    if (url === base) return Promise.resolve(json({ data: client }))
    if (url === `${base}/websites/${websiteID}`)
      return Promise.resolve(json({ data: record }))
    if (url.startsWith(`${base}/websites?`))
      return Promise.resolve(json(page([record])))
    if (url.startsWith(`${base}/websites/${websiteID}/connections?`))
      return Promise.resolve(json(page([])))
    if (url.startsWith(`${base}/integrations?`))
      return Promise.resolve(json(page([])))
    return Promise.resolve(
      json({ error: { code: 'not_found', message: 'Not found' } }),
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
  return fetcher
}
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('rejects malformed deep links before requesting website records', async () => {
  const fetcher = setup(`/app/clients/${clientID}/websites/invalid`)
  await screen.findByRole('heading', { name: 'Website page not found' })
  expect(
    fetcher.mock.calls.every(([url]) => url.startsWith('/api/v1/auth/')),
  ).toBe(true)
})
it('denies a different client without issuing business reads', async () => {
  const session: Session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        { permission: 'clients.view', scope: 'client', client_id: otherID },
      ],
    },
  }
  const fetcher = setup(
    `/app/clients/${clientID}/websites/${websiteID}`,
    session,
  )
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(
    fetcher.mock.calls.every(([url]) => url.startsWith('/api/v1/auth/')),
  ).toBe(true)
})
it('shows authentic entered content and website navigation without client-wide report requests', async () => {
  const fetcher = setup(`/app/clients/${clientID}/websites/${websiteID}`)
  await screen.findByRole('heading', { name: 'Clients' })
  expect(screen.getByText('Synthetic customer content')).toBeVisible()
  expect(screen.getByLabelText('Switch website')).toHaveValue(websiteID)
  expect(
    within(
      screen.getByRole('navigation', { name: 'Website modules' }),
    ).getByRole('link', { name: 'Commerce' }),
  ).toHaveAttribute(
    'href',
    `/app/clients/${clientID}/websites/${websiteID}/commerce`,
  )
  expect(
    fetcher.mock.calls.some(
      ([url]) => url === `${base}/analytics` || url === `${base}/commerce`,
    ),
  ).toBe(false)
})
it('requires confirmation and the current revision before making a website primary', async () => {
  const fetcher = setup(`/app/clients/${clientID}/websites/${websiteID}`)
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Set as primary' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Set primary website' })
  expect(
    fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
  ).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }))
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, options]) =>
          url.endsWith('/primary') &&
          options?.body === '{"expected_revision":1,"confirm":true}',
      ),
    ).toBe(true),
  )
  expect(await screen.findByText('Primary website updated.')).toBeVisible()
})
it('retains archived site history and hides edit, primary and archive controls', async () => {
  setup(`/app/clients/${clientID}/websites/${websiteID}`, identity, {
    ...website,
    status: 'archived',
    archived_at: timestamp,
  })
  await screen.findByRole('heading', { name: 'Clients' })
  expect(
    screen.getByText(/History and stored reports remain available/),
  ).toBeVisible()
  for (const name of ['Edit website', 'Set as primary', 'Archive website'])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
})
