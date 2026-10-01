import { faHouse, faShieldHalved, faUsers, faUserShield } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { hasPermission } from '../auth/permissions'
import type { PermissionRequirement } from '../auth/permissions'
import type { Grant } from '../auth/session'

export interface Destination { path: string; label: string; icon: IconDefinition; required?: PermissionRequirement }

// Register a destination only when its page and backend contract exist.
export const destinations: readonly Destination[] = [
  { path: '/app', label: 'Workspace', icon: faHouse },
  { path: '/app/access', label: 'My access', icon: faShieldHalved },
  { path: '/app/users', label: 'Users', icon: faUsers, required: { permission: 'users.view', scope: 'global' } },
  { path: '/app/roles', label: 'Roles', icon: faUserShield, required: { permission: 'roles.view', scope: 'global' } },
]

export function visibleDestinations(grants: readonly Grant[], registered = destinations) {
  return registered.filter((destination) => !destination.required || hasPermission(grants, destination.required))
}

export function safeReturnTo(value: unknown) {
  return typeof value === 'string' && destinations.some((destination) => destination.path === value) ? value : '/app'
}
