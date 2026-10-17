import { isUUID } from './session'
import type { Grant } from './session'

// Mirrors the documented catalog, not role names. Unknown keys fail closed.
const permissionScopes: Record<string, 'global' | 'client'> = {
  'mcp.manage': 'global',
  'users.view': 'global',
  'users.manage': 'global',
  'roles.view': 'global',
  'roles.manage': 'global',
  'audit.view': 'global',
  'clients.create': 'global',
  'clients.view': 'client',
  'clients.update': 'client',
  'clients.archive': 'client',
  'billing.view': 'client',
  'billing.manage': 'client',
  'pricing.view': 'client',
  'pricing.manage': 'client',
  'billing.create': 'client',
  'billing.update': 'client',
  'billing.delete': 'client',
  'tasks.view': 'client',
  'tasks.read_team': 'client',
  'tasks.read_development': 'client',
  'tasks.assign_team': 'client',
  'finance.approve_adjustment': 'client',
  'tasks.read_own': 'client',
  'tasks.update_own': 'client',
  'tasks.manage': 'client',
  'analytics.view': 'client',
  'integrations.manage': 'client',
  'tasks.create': 'client',
  'tasks.update': 'client',
  'tasks.delete': 'client',
  'planning.view': 'client',
  'planning.create': 'client',
  'planning.update': 'client',
  'planning.archive': 'client',
  'reminders.view': 'client',
  'reminders.create': 'client',
  'reminders.update': 'client',
  'activity.view': 'client',
  'integrations.view': 'client',
  'tickets.create': 'client',
  'tickets.read_own': 'client',
  'tickets.read_team': 'client',
  'tickets.read_all': 'client',
  'tickets.accept': 'client',
  'tickets.reject': 'client',
  'tickets.assign': 'client',
  'tickets.deliver': 'client',
  'tickets.approve': 'client',
  'tickets.request_revision': 'client',
  'tickets.reopen': 'client',
  'tickets.cancel': 'client',
  'staff.read_team': 'global',
  'staff.manage': 'global',
  'staff.assign_brands': 'client',
  'finance.read_company': 'global',
  'agreements.view': 'client',
  'agreements.manage': 'client',
  'billing.reverse': 'client',
  'recurring.view': 'client',
  'recurring.manage': 'client',
  'settings.manage': 'global',
}

export type PermissionRequirement =
  | { permission: string; scope: 'global' }
  | { permission: string; scope: 'client'; clientID: string }

export function permissionScope(key: string) {
  return Object.hasOwn(permissionScopes, key)
    ? permissionScopes[key]
    : undefined
}

export function hasPermission(
  grants: readonly Grant[],
  required: PermissionRequirement,
) {
  if (
    !Object.hasOwn(permissionScopes, required.permission) ||
    permissionScopes[required.permission] !== required.scope
  )
    return false
  if (required.scope === 'client' && !isUUID(required.clientID)) return false
  return grants.some(
    (grant) =>
      grant.permission === required.permission &&
      (required.scope === 'global'
        ? grant.scope === 'global'
        : grant.scope === 'global' ||
          (grant.scope === 'client' && grant.client_id === required.clientID)),
  )
}

export function canListClients(grants: readonly Grant[]) {
  return grants.some(
    (g) =>
      g.permission === 'clients.view' &&
      (g.scope === 'global' || (g.scope === 'client' && isUUID(g.client_id))),
  )
}
export function canOpenClients(grants: readonly Grant[]) {
  return (
    canListClients(grants) ||
    hasPermission(grants, { permission: 'clients.create', scope: 'global' })
  )
}
