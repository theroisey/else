import { isRecord, isUUID } from '../auth/session'
import type { Grant } from '../auth/session'
import { hasPermission, permissionScope } from '../auth/permissions'

export interface User {
  id: string
  email: string
  display_name: string
  status: 'active' | 'disabled'
  revision: number
  created_at: string
  updated_at: string
  last_login_at: string | null
}
export interface Role {
  id: string
  display_name: string
  system_role: boolean
  revision: number
  permissions: string[]
  created_at: string
  updated_at: string
}
export interface Assignment {
  id: string
  user_id: string
  role_id: string
  display_name: string
  scope: 'global' | 'client'
  client_id: string | null
  assigned_at: string
}
export interface Permission {
  permission: string
  scope: 'global' | 'client'
  description: string
}
export interface Page<T> {
  data: T[]
  page: { limit: number; next_cursor: string | null }
}

function invalid(): never {
  throw new Error('Invalid administration response.')
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    [...value].length > 0 &&
    [...value].length <= max
  )
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parseUser(value: unknown): User {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !text(value.email, 254) ||
    !text(value.display_name, 100) ||
    (value.status !== 'active' && value.status !== 'disabled') ||
    !revision(value.revision) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at) ||
    (value.last_login_at !== null && !timestamp(value.last_login_at))
  )
    return invalid()
  return {
    id: value.id,
    email: value.email,
    display_name: value.display_name,
    status: value.status as User['status'],
    revision: value.revision,
    created_at: value.created_at,
    updated_at: value.updated_at,
    last_login_at: value.last_login_at as string | null,
  }
}
export function parseRole(value: unknown): Role {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !text(value.display_name, 100) ||
    typeof value.system_role !== 'boolean' ||
    !revision(value.revision) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at) ||
    !Array.isArray(value.permissions) ||
    value.permissions.length > 100 ||
    !value.permissions.every(
      (p: unknown) => typeof p === 'string' && permissionScope(p),
    ) ||
    new Set(value.permissions).size !== value.permissions.length
  )
    return invalid()
  return {
    id: value.id,
    display_name: value.display_name,
    system_role: value.system_role,
    revision: value.revision,
    permissions: value.permissions as string[],
    created_at: value.created_at,
    updated_at: value.updated_at,
  }
}
export function parseAssignment(value: unknown): Assignment {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !isUUID(value.user_id) ||
    !isUUID(value.role_id) ||
    !text(value.display_name, 100) ||
    !timestamp(value.assigned_at) ||
    (value.scope !== 'global' && value.scope !== 'client') ||
    (value.scope === 'global'
      ? value.client_id !== null
      : !isUUID(value.client_id))
  )
    return invalid()
  return {
    id: value.id,
    user_id: value.user_id,
    role_id: value.role_id,
    display_name: value.display_name,
    scope: value.scope,
    client_id: value.client_id as string | null,
    assigned_at: value.assigned_at,
  }
}
export function parseCatalog(body: unknown): Permission[] {
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length > 100)
    return invalid()
  const result = body.data.map((value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.permission !== 'string' ||
      (value.scope !== 'global' && value.scope !== 'client') ||
      permissionScope(value.permission) !== value.scope ||
      !text(value.description, 160)
    )
      return invalid()
    return {
      permission: value.permission,
      scope: value.scope as Permission['scope'],
      description: value.description,
    }
  })
  if (new Set(result.map((p) => p.permission)).size !== result.length)
    return invalid()
  return result
}
export function parsePage<T>(
  body: unknown,
  parse: (value: unknown) => T,
): Page<T> {
  if (
    !isRecord(body) ||
    !Array.isArray(body.data) ||
    !isRecord(body.page) ||
    !revision(body.page.limit) ||
    body.page.limit > 100 ||
    body.data.length > body.page.limit ||
    (body.page.next_cursor !== null && !isUUID(body.page.next_cursor))
  )
    return invalid()
  return {
    data: body.data.map(parse),
    page: {
      limit: body.page.limit,
      next_cursor: body.page.next_cursor as string | null,
    },
  }
}
export function globallyControls(grants: readonly Grant[], permission: string) {
  return (
    !!permissionScope(permission) &&
    grants.some((g) => g.permission === permission && g.scope === 'global')
  )
}
export function canAssign(
  grants: readonly Grant[],
  role: Role,
  scope: 'global' | 'client',
  client: string,
) {
  if (!hasPermission(grants, { permission: 'roles.manage', scope: 'global' }))
    return false
  const applicable = role.permissions.filter(
    (p) => scope === 'global' || permissionScope(p) === 'client',
  )
  return (
    applicable.length > 0 &&
    applicable.every((p) =>
      scope === 'global'
        ? globallyControls(grants, p)
        : hasPermission(grants, {
            permission: p,
            scope: 'client',
            clientID: client,
          }),
    )
  )
}
export function profileErrors(email: string, name: string, password?: string) {
  const errors: Record<string, string> = {}
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      email.trim().toLowerCase(),
    ) ||
    email.trim().length > 254
  )
    errors.email = 'Enter a valid email address.'
  if (
    !name.trim() ||
    [...name.trim()].length > 100 ||
    /[\p{Cc}]/u.test(name.trim())
  )
    errors.name = 'Use 1–100 characters without control characters.'
  if (
    password !== undefined &&
    (new TextEncoder().encode(password).length < 12 ||
      new TextEncoder().encode(password).length > 128)
  )
    errors.password = 'Use a password of 12–128 bytes.'
  return errors
}
