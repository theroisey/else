import { afterEach, expect, it, vi } from 'vitest'
import { request, AdministrationError, users } from './service'
import { canAssign, parseCatalog, parseUser, profileErrors } from './models'
import type { Role } from './models'

afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})

it('uses same-origin credentials, CSRF and bounded cursor requests without arbitrary URLs', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const id = '11111111-1111-4111-8111-111111111111'
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ data: { id, revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  await request('/users', {
    method: 'POST',
    body: {
      email: 'synthetic@example.com',
      display_name: 'Synthetic',
      password: 'synthetic test password',
    },
  })
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/users',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'a'.repeat(43) }),
    }),
  )
  await expect(request('/users/../../secrets')).rejects.toBeInstanceOf(AdministrationError)
  await expect(request('/users', { cursor: 'token=synthetic-secret' })).rejects.toBeInstanceOf(
    AdministrationError,
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('rejects malformed responses and exposes safe error messages instead of server details', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'conflict', message: 'password=synthetic-secret SQL detail' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
  )
  await expect(request('/users')).rejects.toThrow('Reload current data')
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [], page: { limit: 1000, next_cursor: null } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
  )
  await expect(users(new AbortController().signal, '')).rejects.toThrow(
    'Invalid administration response',
  )
  expect(() =>
    parseCatalog({ data: [{ permission: 'unknown.permission', description: 'Unknown' }] }),
  ).toThrow()
  expect(() => parseUser({ status: ['active'] })).toThrow()
})

it('matches identity validation and refuses global escalation from a client grant', () => {
  expect(profileErrors('valid@example.com', 'Valid', 'short')).toHaveProperty('password')
  expect(profileErrors('bad', 'Name\ncontrol')).toMatchObject({
    email: expect.any(String),
    name: expect.any(String),
  })
  const role: Role = {
    id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Viewer',
    system_role: false,
    revision: 1,
    permissions: ['clients.view', 'users.manage'],
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  }
  const client = '22222222-2222-4222-8222-222222222222'
  const grants = [
    { permission: 'roles.manage', scope: 'global' as const },
    { permission: 'clients.view', scope: 'client' as const, client_id: client },
  ]
  expect(canAssign(grants, role, 'global', '')).toBe(false)
  expect(canAssign(grants, role, 'client', client)).toBe(true)
  expect(canAssign(grants, role, 'client', '33333333-3333-4333-8333-333333333333')).toBe(false)
})
