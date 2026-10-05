import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import type { Session } from '../auth/session'
import type { User, Role } from './models'

const actor = '11111111-1111-4111-8111-111111111111'
const target = '11111111-1111-4111-8111-111111111112'
const roleID = '22222222-2222-4222-8222-222222222222'
const date = '2026-10-01T00:00:00Z'
const user: User = {
  id: target,
  email: 'target@example.com',
  display_name: 'Target Fixture',
  status: 'active',
  revision: 1,
  created_at: date,
  updated_at: date,
  last_login_at: null,
}
const role: Role = {
  id: roleID,
  display_name: 'Custom Viewer',
  system_role: false,
  revision: 1,
  permissions: ['clients.view'],
  created_at: date,
  updated_at: date,
}
const identity: Session = {
  user: {
    id: actor,
    email: 'administrator@example.com',
    display_name: 'Administrator Fixture',
    permissions: [
      'users.view',
      'users.manage',
      'roles.view',
      'roles.manage',
      'clients.view',
      'tasks.view',
    ].map((permission) => ({ permission, scope: 'global' })),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
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
  path: string,
  init: RequestInit,
) => Response | Promise<Response> | undefined
function setup(
  path = '/app/users',
  session = identity,
  override: Override = () => undefined,
) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit = {}) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: session }))
    if (url.startsWith('/api/v1/users?'))
      return Promise.resolve(json(page([user])))
    if (url.startsWith('/api/v1/roles?'))
      return Promise.resolve(json(page([role])))
    if (url === '/api/v1/permissions')
      return Promise.resolve(
        json({
          data: [
            {
              permission: 'clients.view',
              scope: 'client',
              description: 'View clients',
            },
            {
              permission: 'tasks.view',
              scope: 'client',
              description: 'View tasks',
            },
            {
              permission: 'users.manage',
              scope: 'global',
              description: 'Manage users',
            },
          ],
        }),
      )
    if (url === `/api/v1/users/${target}/roles?limit=25`)
      return Promise.resolve(json(page([])))
    if (url === `/api/v1/roles/${roleID}`)
      return Promise.resolve(json({ data: role }))
    return Promise.resolve(json({ data: { id: target, revision: 2 } }))
  })
  vi.stubGlobal('fetch', fetcher)
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { fetcher, client }
}
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})

it('denies deep links and avoids administration requests without the exact view permission', async () => {
  const session = { ...identity, user: { ...identity.user, permissions: [] } }
  const { fetcher } = setup('/app/users', session)
  expect(
    await screen.findByRole('heading', { name: 'Access denied' }),
  ).toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(
      ([path]) =>
        path === '/api/v1/auth/session' || path === '/api/v1/auth/preferences',
    ),
  ).toBe(true)
  expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
})

it('refreshes revoked access after a denied administration read and removes the controls', async () => {
  let identities = 0
  setup('/app/users', identity, (path) => {
    if (path === '/api/v1/auth/session') {
      identities++
      return json({
        data:
          identities === 1
            ? identity
            : { ...identity, user: { ...identity.user, permissions: [] } },
      })
    }
    if (path.startsWith('/api/v1/users?'))
      return json({ error: { code: 'permission_denied' } }, 403)
  })
  expect(
    await screen.findByRole('heading', { name: 'Access denied' }),
  ).toBeInTheDocument()
  expect(identities).toBe(2)
  expect(
    screen.queryByRole('button', { name: 'Create account' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('table', { name: 'User accounts' }),
  ).not.toBeInTheDocument()
})

it('offers no writes to view-only users', async () => {
  const session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [{ permission: 'users.view', scope: 'global' as const }],
    },
  }
  setup('/app/users', session)
  await screen.findByRole('table', { name: 'User accounts' })
  expect(
    screen.queryByRole('button', { name: 'Create account' }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Disable Target/ }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Roles for/ }),
  ).not.toBeInTheDocument()
})

it('shows loading, safe errors, retry and an empty page without leaking response details', async () => {
  let release: (value: Response) => void = () => {}
  let reads = 0
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  setup('/app/users', identity, (path) => {
    if (path.startsWith('/api/v1/users?')) {
      reads++
      return reads === 1 ? pending : json(page([]))
    }
  })
  expect(await screen.findByText('Loading users…')).toBeInTheDocument()
  release(
    json(
      { error: { code: 'internal_error', message: 'private database detail' } },
      500,
    ),
  )
  expect(await screen.findByRole('alert')).not.toHaveTextContent(
    'private database detail',
  )
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByRole('heading', { name: 'No users on this page' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})

it('moves between bounded pages using the server cursor and restores the previous page', async () => {
  const { fetcher } = setup('/app/users', identity, (path) => {
    if (path === '/api/v1/users?limit=25')
      return json({ data: [user], page: { limit: 25, next_cursor: target } })
    if (path === `/api/v1/users?limit=25&cursor=${target}`)
      return json(page([{ ...user, id: roleID, display_name: 'Next Fixture' }]))
  })
  const u = userEvent.setup()
  await screen.findByRole('button', { name: 'Edit Target Fixture' })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByRole('button', { name: 'Edit Next Fixture' })
  expect(
    fetcher.mock.calls.some(
      ([path]) => path === `/api/v1/users?limit=25&cursor=${target}`,
    ),
  ).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Previous' }))
  expect(
    await screen.findByRole('button', { name: 'Edit Target Fixture' }),
  ).toBeInTheDocument()
})

it('validates creation and clears the password after a failed request without caching it', async () => {
  const { client, fetcher } = setup('/app/users', identity, (path, init) =>
    path === '/api/v1/users' && init?.method === 'POST'
      ? json(
          { error: { code: 'conflict', message: 'unsafe fixture detail' } },
          409,
        )
      : undefined,
  )
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Create account' }))
  const dialog = within(screen.getByRole('dialog'))
  await u.click(dialog.getByRole('button', { name: 'Create account' }))
  expect(dialog.getByText('Enter a valid email address.')).toBeInTheDocument()
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  )
  await u.type(dialog.getByLabelText('Display name'), 'Created Fixture')
  await u.type(dialog.getByLabelText('Email'), 'created@example.com')
  await u.type(
    dialog.getByLabelText('Initial password'),
    'clearly synthetic test password',
  )
  await u.click(dialog.getByRole('button', { name: 'Create account' }))
  expect(await dialog.findByRole('alert')).toHaveTextContent('record changed')
  expect(dialog.getByLabelText('Initial password')).toHaveValue('')
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain('clearly synthetic test password')
  expect(client.getMutationCache().getAll()).toHaveLength(0)
  expect(localStorage.length + sessionStorage.length).toBe(0)
})

it('requires confirmation for disablement and preserves the safe last-administrator error', async () => {
  const { fetcher } = setup('/app/users', identity, (path, init) =>
    path.endsWith('/disable') && init?.method === 'POST'
      ? json({ error: { code: 'last_administrator' } }, 409)
      : undefined,
  )
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', { name: 'Disable Target Fixture' }),
  )
  expect(fetcher.mock.calls.some(([path]) => path.endsWith('/disable'))).toBe(
    false,
  )
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await u.click(screen.getByRole('button', { name: 'Disable account' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'At least one active administrator',
  )
  const request = fetcher.mock.calls.find(([path]) => path.endsWith('/disable'))
  expect(JSON.parse(request?.[1]?.body as string)).toEqual({
    expected_revision: 1,
    confirm: true,
  })
})

it('reloads a stale profile explicitly and submits the new revision', async () => {
  let writes = 0
  const { fetcher } = setup('/app/users', identity, (path, init) => {
    if (path === `/api/v1/users/${target}` && init?.method === 'PATCH') {
      writes++
      return writes === 1
        ? json({ error: { code: 'conflict' } }, 409)
        : json({ data: { id: target, revision: 3 } })
    }
    if (path === `/api/v1/users/${target}` && init?.method === 'GET')
      return json({
        data: { ...user, revision: 2, display_name: 'Current Fixture' },
      })
  })
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', { name: 'Edit Target Fixture' }),
  )
  await u.click(screen.getByRole('button', { name: 'Save account' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('record changed')
  await u.click(screen.getByRole('button', { name: 'Reload current data' }))
  await waitFor(() =>
    expect(screen.getByLabelText('Display name')).toHaveValue(
      'Current Fixture',
    ),
  )
  await u.click(screen.getByRole('button', { name: 'Save account' }))
  await screen.findByText('Account updated.')
  const patches = fetcher.mock.calls.filter(
    ([, init]) => init?.method === 'PATCH',
  )
  expect(JSON.parse(patches[1]?.[1]?.body as string).expected_revision).toBe(2)
})

it('confirms custom permission replacement before changing all holders', async () => {
  const { fetcher } = setup('/app/roles')
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', {
      name: 'Edit permissions for Custom Viewer',
    }),
  )
  await u.click(await screen.findByRole('checkbox', { name: /tasks.view/ }))
  await u.click(screen.getByRole('button', { name: 'Review changes' }))
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(
    false,
  )
  await u.click(screen.getByRole('button', { name: 'Replace permissions' }))
  await screen.findByText('Role permissions updated.')
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({
    permissions: ['clients.view', 'tasks.view'],
    expected_revision: 1,
    confirm: true,
  })
})

it('keeps built-in role definitions read only even for a role administrator', async () => {
  const { fetcher } = setup('/app/roles', identity, (path) =>
    path.startsWith('/api/v1/roles?')
      ? json(page([{ ...role, system_role: true }]))
      : undefined,
  )
  await userEvent
    .setup()
    .click(
      await screen.findByRole('button', {
        name: 'View permissions for Custom Viewer',
      }),
    )
  const checkbox = await screen.findByRole('checkbox', { name: /clients.view/ })
  expect(checkbox).toBeDisabled()
  expect(
    screen.queryByRole('button', { name: 'Review changes' }),
  ).not.toBeInTheDocument()
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(
    false,
  )
})

it('reads and edits an expanded billing role through the existing confirmed administration flow', async () => {
  const permissions = [
    'billing.view',
    'billing.create',
    'billing.update',
    'billing.delete',
  ]
  const billingRole = {
    ...role,
    display_name: 'Synthetic Collections',
    permissions,
  }
  const session: Session = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        ...identity.user.permissions,
        ...permissions.map((permission) => ({
          permission,
          scope: 'global' as const,
        })),
      ],
    },
  }
  const { fetcher } = setup('/app/roles', session, (path) => {
    if (path.startsWith('/api/v1/roles?')) return json(page([billingRole]))
    if (path === '/api/v1/permissions')
      return json({
        data: permissions.map((permission) => ({
          permission,
          scope: 'client',
          description: 'Synthetic billing capability',
        })),
      })
  })
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', {
      name: 'Edit permissions for Synthetic Collections',
    }),
  )
  for (const permission of permissions) {
    expect(
      await screen.findByRole('checkbox', {
        name: new RegExp(permission.replace('.', '\\.')),
      }),
    ).toBeChecked()
  }
  await u.click(screen.getByRole('checkbox', { name: /billing\.delete/ }))
  await u.click(screen.getByRole('button', { name: 'Review changes' }))
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(
    false,
  )
  await u.click(screen.getByRole('button', { name: 'Replace permissions' }))
  await screen.findByText('Role permissions updated.')
  const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
  expect(put?.[0]).toBe(`/api/v1/roles/${roleID}/permissions`)
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({
    permissions: ['billing.view', 'billing.create', 'billing.update'],
    expected_revision: 1,
    confirm: true,
  })
})

it('assigns a role at a confirmed client scope and revokes only the selected assignment', async () => {
  const assignment = '33333333-3333-4333-8333-333333333333'
  let assigned = false
  const { fetcher } = setup('/app/users', identity, (path, init) => {
    if (path === `/api/v1/users/${target}/roles` && init?.method === 'POST') {
      assigned = true
      return json({ data: { id: assignment } }, 201)
    }
    if (path === `/api/v1/users/${target}/roles?limit=25`)
      return json(
        page(
          assigned
            ? [
                {
                  id: assignment,
                  user_id: target,
                  role_id: roleID,
                  display_name: role.display_name,
                  scope: 'client',
                  client_id: roleID,
                  assigned_at: date,
                },
              ]
            : [],
        ),
      )
    if (init?.method === 'DELETE') {
      assigned = false
      return new Response(null, { status: 204 })
    }
  })
  const u = userEvent.setup()
  await u.click(
    await screen.findByRole('button', { name: 'Roles for Target Fixture' }),
  )
  await u.selectOptions(
    await screen.findByRole('combobox', { name: 'Scope' }),
    'client',
  )
  await u.type(screen.getByLabelText('Client ID'), roleID)
  await u.selectOptions(screen.getByRole('combobox', { name: 'Role' }), roleID)
  await u.click(screen.getByRole('button', { name: 'Review assignment' }))
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  )
  await u.click(screen.getByRole('button', { name: 'Assign role' }))
  await u.click(
    await screen.findByRole('button', { name: 'Remove Custom Viewer' }),
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Remove assignment' }),
    ).toBeEnabled(),
  )
  await u.click(screen.getByRole('button', { name: 'Remove assignment' }))
  await screen.findByText('Role assignment removed.')
  const added = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
  expect(JSON.parse(added?.[1]?.body as string)).toEqual({
    role_id: roleID,
    scope: 'client',
    client_id: roleID,
    confirm: true,
  })
  expect(
    fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0],
  ).toBe(`/api/v1/users/${target}/roles/${assignment}`)
})
