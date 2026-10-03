import { expect, it } from 'vitest'
import { hasPermission, permissionScope } from '../auth/permissions'
import { parseSession } from '../auth/session'
import type { Grant } from '../auth/session'
import { canAssign, globallyControls, parseCatalog, parseRole } from './models'

const clientID = '11111111-1111-4111-8111-111111111111'
const otherID = '22222222-2222-4222-8222-222222222222'
const view = 'integrations.view'
const role = {
  id: otherID,
  display_name: 'Synthetic integration reader',
  system_role: false,
  revision: 1,
  permissions: ['clients.view', view],
  created_at: '2026-10-03T00:00:00Z',
  updated_at: '2026-10-03T00:00:00Z',
}
const catalog = (permission: string, scope = 'client') => ({
  permission,
  scope,
  description: 'Synthetic integration capability',
})
function session(permissions: Grant[]) {
  return parseSession({
    data: {
      user: {
        id: otherID,
        email: 'synthetic@example.com',
        display_name: 'Synthetic integration actor',
        permissions,
      },
      session: { expires_at: '2099-01-01T00:00:00Z' },
    },
  }).user.permissions
}

it('accepts old and expanded administration catalogs without changing permission scope', () => {
  const old = [catalog('analytics.view'), catalog('integrations.manage')]
  expect(parseCatalog({ data: old })).toEqual(old)
  expect(parseCatalog({ data: [...old, catalog(view)] })).toEqual([...old, catalog(view)])
  expect(permissionScope(view)).toBe('client')
  expect(() => parseCatalog({ data: [catalog(view, 'global')] })).toThrow()
  expect(() => parseCatalog({ data: [catalog(view), catalog(view)] })).toThrow()
})

it('accepts integration-reader roles while retaining old roles and rejecting duplicate keys', () => {
  expect(parseRole(role).permissions).toEqual(['clients.view', view])
  expect(parseRole({ ...role, permissions: ['integrations.manage'] }).permissions).toEqual([
    'integrations.manage',
  ])
  expect(() => parseRole({ ...role, permissions: [view, view] })).toThrow()
})

it('recognizes identity view grants only in an explicit valid client context', () => {
  const scoped = session([{ permission: view, scope: 'client', client_id: clientID }])
  const required = { permission: view, scope: 'client' as const, clientID }
  expect(hasPermission(scoped, required)).toBe(true)
  expect(hasPermission(scoped, { ...required, clientID: otherID })).toBe(false)
  expect(hasPermission(scoped, { permission: view, scope: 'global' })).toBe(false)
  expect(globallyControls(scoped, view)).toBe(false)
  const global = session([{ permission: view, scope: 'global' }])
  expect(hasPermission(global, required)).toBe(true)
  expect(hasPermission(global, { ...required, clientID: otherID })).toBe(true)
  expect(globallyControls(global, view)).toBe(true)
  for (const clientID of ['', 'invalid', '00000000-0000-0000-0000-000000000000']) {
    expect(hasPermission(global, { ...required, clientID })).toBe(false)
  }
  expect(hasPermission(global, { permission: view, scope: 'global' })).toBe(false)
  expect(hasPermission([], required)).toBe(false)
})

it.each(['integrations.manage', 'analytics.view', 'clients.view'])(
  'does not infer integration view from %s',
  (permission) => {
    expect(
      hasPermission(session([{ permission, scope: 'global' }]), {
        permission: view,
        scope: 'client',
        clientID,
      }),
    ).toBe(false)
  },
)

it('does not infer manage, analytics or client access from integration view', () => {
  const grants = session([{ permission: view, scope: 'global' }])
  for (const permission of ['integrations.manage', 'analytics.view', 'clients.view']) {
    expect(hasPermission(grants, { permission, scope: 'client', clientID })).toBe(false)
  }
})

it('requires roles.manage and authority for both client and integration view when delegating a reader', () => {
  const parsed = parseRole(role)
  const grants: Grant[] = [
    { permission: 'roles.manage', scope: 'global' },
    ...role.permissions.map((permission) => ({
      permission,
      scope: 'client' as const,
      client_id: clientID,
    })),
  ]
  expect(canAssign(grants, parsed, 'client', clientID)).toBe(true)
  expect(canAssign(grants, parsed, 'client', otherID)).toBe(false)
  expect(canAssign(grants, parsed, 'client', '')).toBe(false)
  expect(canAssign(grants, parsed, 'global', '')).toBe(false)
  for (const missing of ['roles.manage', ...role.permissions]) {
    expect(
      canAssign(
        grants.filter((g) => g.permission !== missing),
        parsed,
        'client',
        clientID,
      ),
    ).toBe(false)
  }
  const legacy: Grant[] = [
    'roles.manage',
    'clients.view',
    'integrations.manage',
    'analytics.view',
  ].map((permission) => ({ permission, scope: 'global' }))
  expect(canAssign(legacy, parsed, 'global', '')).toBe(false)
})

it('requires independent global authority for every permission when delegating an integration manager', () => {
  const parsed = parseRole({
    ...role,
    permissions: [...role.permissions, 'integrations.manage'],
  })
  const grants: Grant[] = ['roles.manage', ...parsed.permissions].map((permission) => ({
    permission,
    scope: 'global',
  }))
  expect(canAssign(grants, parsed, 'global', '')).toBe(true)
  for (const missing of ['roles.manage', ...parsed.permissions]) {
    expect(
      canAssign(
        grants.filter((g) => g.permission !== missing),
        parsed,
        'global',
        '',
      ),
    ).toBe(false)
  }
  expect(
    canAssign(
      grants.map((g) =>
        g.permission === view ? { permission: view, scope: 'client', client_id: clientID } : g,
      ),
      parsed,
      'global',
      '',
    ),
  ).toBe(false)
})

it('preserves unknown identity keys without accepting or authorizing them elsewhere', () => {
  for (const permission of [
    'integrations.connect',
    'integrations.sync',
    'integrations.view_extra',
  ]) {
    const grants = session([{ permission, scope: 'global' }])
    expect(grants[0]?.permission).toBe(permission)
    expect(permissionScope(permission)).toBeUndefined()
    expect(hasPermission(grants, { permission, scope: 'client', clientID })).toBe(false)
    expect(globallyControls(grants, permission)).toBe(false)
    expect(() => parseCatalog({ data: [catalog(permission)] })).toThrow()
    expect(() => parseRole({ ...role, permissions: [permission] })).toThrow()
  }
})

it('rejects malformed scope bindings for identity integration grants', () => {
  expect(() => session([{ permission: view, scope: 'client' }])).toThrow()
  expect(() => session([{ permission: view, scope: 'client', client_id: 'invalid' }])).toThrow()
  expect(() => session([{ permission: view, scope: 'global', client_id: clientID }])).toThrow()
})
