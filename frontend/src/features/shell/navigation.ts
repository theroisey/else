import { faHouse, faShieldHalved } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { hasPermission } from '../auth/permissions'
import type { PermissionRequirement } from '../auth/permissions'
import type { Grant } from '../auth/session'

export interface Destination { path: string; label: string; icon: IconDefinition; required?: PermissionRequirement }

// Register a destination only when its page and backend contract exist.
export const destinations: readonly Destination[] = [
  { path: '/app', label: 'Workspace', icon: faHouse },
  { path: '/app/access', label: 'My access', icon: faShieldHalved },
]

export function visibleDestinations(grants: readonly Grant[], registered = destinations) {
  return registered.filter((destination) => !destination.required || hasPermission(grants, destination.required))
}

export function safeReturnTo(value: unknown) {
  return typeof value === 'string' && destinations.some((destination) => destination.path === value) ? value : '/app'
}
