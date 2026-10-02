import { faHouse, faShieldHalved, faUsers, faUserShield, faBuilding } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { hasPermission } from '../auth/permissions'
import type { PermissionRequirement } from '../auth/permissions'
import type { Grant } from '../auth/session'
import { isUUID } from '../auth/session'
import { canOpenClients } from '../auth/permissions'

export interface Destination { path: string; label: string; icon: IconDefinition; required?: PermissionRequirement; visible?: (grants: readonly Grant[]) => boolean }

// Register a destination only when its page and backend contract exist.
export const destinations: readonly Destination[] = [
  { path: '/app', label: 'Workspace', icon: faHouse },
  { path: '/app/access', label: 'My access', icon: faShieldHalved },
  { path: '/app/clients', label: 'Clients', icon: faBuilding, visible: canOpenClients },
  { path: '/app/users', label: 'Users', icon: faUsers, required: { permission: 'users.view', scope: 'global' } },
  { path: '/app/roles', label: 'Roles', icon: faUserShield, required: { permission: 'roles.view', scope: 'global' } },
]

export function visibleDestinations(grants: readonly Grant[], registered = destinations) {
  return registered.filter((destination) => (!destination.required || hasPermission(grants, destination.required)) && (!destination.visible || destination.visible(grants)))
}

export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string') return '/app'
  if (destinations.some(destination => destination.path === value) || value === '/app/clients/new') return value
  const match = /^\/app\/clients\/([^/]+)(?:\/edit)?$/.exec(value)
  if (match && isUUID(match[1])) return value
  const task = /^\/app\/clients\/([^/]+)\/tasks(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(value)
  return task && isUUID(task[1]) && (!task[2] || task[2] === 'new' && !task[3] || isUUID(task[2])) ? value : '/app'
}
