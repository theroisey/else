import { expect, it } from 'vitest'
import { hasPermission, permissionScope } from '../auth/permissions'
import { parseSession } from '../auth/session'
import type { Grant } from '../auth/session'
import { canAssign, globallyControls, parseCatalog, parseRole } from './models'

const clientID = '11111111-1111-4111-8111-111111111111'
const otherID = '22222222-2222-4222-8222-222222222222'
const keys = ['billing.create', 'billing.update', 'billing.delete']
const role = {
  id: otherID,
  display_name: 'Synthetic collection role',
  system_role: false,
  revision: 1,
  permissions: ['billing.view', ...keys],
  created_at: '2026-10-02T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
}
const catalog = (permission: string, scope = 'client') => ({
  permission,
  scope,
  description: 'Synthetic billing capability',
})
function session(permissions: Grant[]) {
  return parseSession({
    data: {
      user: {
        id: otherID,
        email: 'synthetic@example.com',
        display_name: 'Synthetic billing actor',
        permissions,
      },
      session: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    },
  })
}

it.each(keys)(
  'recognizes %s from identity with exact client and global assignment scope',
  (permission) => {
    const grants: Grant[] = [
      { permission, scope: 'client', client_id: clientID },
    ]
    const parsed = session(grants).user.permissions
    expect(parsed).toEqual(grants)
    expect(permissionScope(permission)).toBe('client')
    expect(
      hasPermission(parsed, { permission, scope: 'client', clientID }),
    ).toBe(true)
    expect(
      hasPermission(parsed, { permission, scope: 'client', clientID: otherID }),
    ).toBe(false)
    expect(
      hasPermission(parsed, { permission, scope: 'client', clientID: '' }),
    ).toBe(false)
    expect(hasPermission(parsed, { permission, scope: 'global' })).toBe(false)
    const global = session([{ permission, scope: 'global' }]).user.permissions
    expect(
      hasPermission(global, { permission, scope: 'client', clientID }),
    ).toBe(true)
    expect(hasPermission(global, { permission, scope: 'global' })).toBe(false)
    expect(globallyControls(parsed, permission)).toBe(false)
    expect(globallyControls(global, permission)).toBe(true)
  },
)

it('accepts expanded catalogs and role responses while retaining old billing keys', () => {
  const permissions = ['billing.view', 'billing.manage', ...keys]
  const entries = permissions.map((key) => catalog(key))
  expect(parseCatalog({ data: entries })).toEqual(entries)
  expect(parseRole({ ...role, permissions }).permissions).toEqual(permissions)
  expect(parseCatalog({ data: entries.slice(0, 2) })).toEqual(
    entries.slice(0, 2),
  )
  for (const key of keys) {
    expect(() => parseCatalog({ data: [catalog(key, 'global')] })).toThrow()
    expect(() => parseCatalog({ data: [catalog(key), catalog(key)] })).toThrow()
  }
})

it('requires explicit control of every billing permission for scoped or global role delegation', () => {
  const parsedRole = parseRole(role)
  const grants: Grant[] = [
    { permission: 'roles.manage', scope: 'global' },
    ...role.permissions.map((permission) => ({
      permission,
      scope: 'client' as const,
      client_id: clientID,
    })),
  ]
  expect(canAssign(grants, parsedRole, 'client', clientID)).toBe(true)
  expect(canAssign(grants, parsedRole, 'client', otherID)).toBe(false)
  expect(canAssign(grants, parsedRole, 'global', '')).toBe(false)
  const global: Grant[] = grants.map((grant) => ({
    permission: grant.permission,
    scope: 'global',
  }))
  expect(canAssign(global, parsedRole, 'global', '')).toBe(true)
  for (const key of role.permissions) {
    expect(
      canAssign(
        grants.filter((g) => g.permission !== key),
        parsedRole,
        'client',
        clientID,
      ),
    ).toBe(false)
    expect(
      canAssign(
        global.filter((g) => g.permission !== key),
        parsedRole,
        'global',
        '',
      ),
    ).toBe(false)
  }
  expect(
    canAssign(
      grants.filter((g) => g.permission !== 'roles.manage'),
      parsedRole,
      'client',
      clientID,
    ),
  ).toBe(false)
})

it('does not infer granular billing grants from view, legacy manage, or another write', () => {
  for (const permission of keys) {
    for (const held of [
      'billing.view',
      'billing.manage',
      ...keys.filter((key) => key !== permission),
    ]) {
      expect(
        hasPermission([{ permission: held, scope: 'global' }], {
          permission,
          scope: 'client',
          clientID,
        }),
      ).toBe(false)
    }
    expect(
      hasPermission([{ permission, scope: 'global' }], {
        permission: 'billing.view',
        scope: 'client',
        clientID,
      }),
    ).toBe(false)
  }
  const legacy: Grant[] = [
    'roles.manage',
    'billing.view',
    'billing.manage',
  ].map((permission) => ({ permission, scope: 'global' }))
  expect(canAssign(legacy, parseRole(role), 'global', '')).toBe(false)
})

it('preserves future identity keys without authorizing or accepting them in role/catalog responses', () => {
  for (const permission of [
    'billing.refund',
    'billing.reverse',
    'billing.create_extra',
  ]) {
    const grants = session([{ permission, scope: 'global' }]).user.permissions
    expect(grants[0]?.permission).toBe(permission)
    expect(permissionScope(permission)).toBeUndefined()
    expect(
      hasPermission(grants, { permission, scope: 'client', clientID }),
    ).toBe(false)
    expect(globallyControls(grants, permission)).toBe(false)
    expect(() => parseCatalog({ data: [catalog(permission)] })).toThrow()
    expect(() => parseRole({ ...role, permissions: [permission] })).toThrow()
  }
})
