import { describe, expect, it } from 'vitest'
import { faHouse } from '@fortawesome/free-solid-svg-icons'
import { hasPermission } from './permissions'
import { safeReturnTo, visibleDestinations } from '../shell/navigation'
import type { Grant } from './session'

const clientID = '11111111-1111-4111-8111-111111111111'
const otherID = '22222222-2222-4222-8222-222222222222'
const grants: Grant[] = [{ permission: 'roles.manage', scope: 'global' }, { permission: 'clients.view', scope: 'client', client_id: clientID }]

describe('effective permissions', () => {
  it.each(['tasks.create', 'tasks.update', 'tasks.delete'])('recognizes %s with exact client scope', (permission) => {
    const scoped: Grant[] = [{ permission, scope: 'client', client_id: clientID }]
    expect(hasPermission(scoped, { permission, scope: 'client', clientID })).toBe(true)
    expect(hasPermission(scoped, { permission, scope: 'client', clientID: otherID })).toBe(false)
    expect(hasPermission(scoped, { permission, scope: 'global' })).toBe(false)
    expect(hasPermission([{ permission, scope: 'global' }], { permission, scope: 'client', clientID })).toBe(true)
  })
  it('requires known identifiers and matching global/exact-client scope', () => {
    expect(hasPermission(grants, { permission: 'roles.manage', scope: 'global' })).toBe(true)
    expect(hasPermission(grants, { permission: 'clients.view', scope: 'client', clientID })).toBe(true)
    expect(hasPermission(grants, { permission: 'clients.view', scope: 'client', clientID: otherID })).toBe(false)
    expect(hasPermission(grants, { permission: 'clients.view', scope: 'global' })).toBe(false)
    expect(hasPermission(grants, { permission: 'roles.manage', scope: 'client', clientID })).toBe(false)
    expect(hasPermission([{ permission: 'roles.manage', scope: 'client', client_id: clientID }], { permission: 'roles.manage', scope: 'global' })).toBe(false)
    expect(hasPermission(grants, { permission: 'clients.view', scope: 'client', clientID: '' })).toBe(false)
    expect(hasPermission([{ permission: 'unknown.view', scope: 'global' }], { permission: 'unknown.view', scope: 'global' })).toBe(false)
    expect(hasPermission([], { permission: 'roles.manage', scope: 'global' })).toBe(false)
  })

  it('allows global assignments to satisfy client permissions only with explicit client context', () => {
    expect(hasPermission([{ permission: 'clients.view', scope: 'global' }], { permission: 'clients.view', scope: 'client', clientID: otherID })).toBe(true)
  })

  it('filters registered destinations by the same grants used by guards', () => {
    const registered = [
      { path: '/fixture/home', label: 'Fixture home', icon: faHouse },
      { path: '/fixture/roles', label: 'Fixture roles', icon: faHouse, required: { permission: 'roles.manage', scope: 'global' as const } },
      { path: '/fixture/client', label: 'Fixture client', icon: faHouse, required: { permission: 'clients.view', scope: 'client' as const, clientID: otherID } },
    ]
    expect(visibleDestinations(grants, registered).map((item) => item.path)).toEqual(['/fixture/home', '/fixture/roles'])
    expect(visibleDestinations([], registered).map((item) => item.path)).toEqual(['/fixture/home'])
  })

  it('allows only implemented internal return destinations', () => {
    expect(safeReturnTo('/app/access')).toBe('/app/access')
    for (const value of ['https://invalid.example', '//invalid.example', '/login', '/app/../login', '/app/access?token=secret', '/clients', undefined]) {
      expect(safeReturnTo(value)).toBe('/app')
    }
  })
})
