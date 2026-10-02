import { isUUID } from './session'
import type { Grant } from './session'

// Mirrors the documented catalog, not role names. Unknown keys fail closed.
const permissionScopes: Record<string, 'global' | 'client'> = {
  'users.view': 'global', 'users.manage': 'global', 'roles.view': 'global', 'roles.manage': 'global',
  'audit.view': 'global', 'releases.view': 'global', 'releases.manage': 'global', 'clients.create': 'global',
  'clients.view': 'client', 'clients.update': 'client', 'clients.archive': 'client',
  'billing.view': 'client', 'billing.manage': 'client', 'pricing.view': 'client', 'pricing.manage': 'client',
  'tasks.view': 'client', 'tasks.manage': 'client', 'analytics.view': 'client', 'integrations.manage': 'client',
  'tasks.create': 'client', 'tasks.update': 'client', 'tasks.delete': 'client',
  'planning.view': 'client', 'planning.create': 'client', 'planning.update': 'client', 'planning.archive': 'client',
  'reminders.view': 'client', 'reminders.create': 'client', 'reminders.update': 'client',
  'activity.view': 'client',
}

export type PermissionRequirement = { permission: string; scope: 'global' } | { permission: string; scope: 'client'; clientID: string }

export function permissionScope(key: string) {
  return Object.hasOwn(permissionScopes, key) ? permissionScopes[key] : undefined
}

export function hasPermission(grants: readonly Grant[], required: PermissionRequirement) {
  if (!Object.hasOwn(permissionScopes, required.permission) || permissionScopes[required.permission] !== required.scope) return false
  if (required.scope === 'client' && !isUUID(required.clientID)) return false
  return grants.some((grant) => grant.permission === required.permission && (
    required.scope === 'global' ? grant.scope === 'global'
      : grant.scope === 'global' || (grant.scope === 'client' && grant.client_id === required.clientID)
  ))
}

export function canListClients(grants: readonly Grant[]) {
  return grants.some(g => g.permission === 'clients.view' && (g.scope === 'global' || (g.scope === 'client' && isUUID(g.client_id))))
}
export function canOpenClients(grants: readonly Grant[]) {
  return canListClients(grants) || hasPermission(grants, { permission: 'clients.create', scope: 'global' })
}
