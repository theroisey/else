import { faHouse, faShieldHalved, faUsers, faUserShield, faBuilding, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons'
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
  { path: '/app/audit', label: 'Audit history', icon: faClockRotateLeft, required: { permission: 'audit.view', scope: 'global' } },
]

export function visibleDestinations(grants: readonly Grant[], registered = destinations) {
  return registered.filter((destination) => (!destination.required || hasPermission(grants, destination.required)) && (!destination.visible || destination.visible(grants)))
}

export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string') return '/app'
  if (destinations.some(destination => destination.path === value) || value === '/app/clients/new') return value
  const match = /^\/app\/clients\/([^/]+)(?:\/(edit|profile))?$/.exec(value)
  if (match && isUUID(match[1])) return value
  const activity = /^\/app\/clients\/([^/]+)\/activity$/.exec(value)
  if (activity && isUUID(activity[1])) return value
  const audit = /^\/app\/clients\/([^/]+)\/audit$/.exec(value)
  if (audit && isUUID(audit[1])) return value
  const task = /^\/app\/clients\/([^/]+)\/tasks(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(value)
  if (task && isUUID(task[1]) && (!task[2] || task[2] === 'new' && !task[3] || isUUID(task[2]))) return value
  const reminder = /^\/app\/clients\/([^/]+)\/reminders(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(value)
  if (reminder && isUUID(reminder[1]) && (!reminder[2] || reminder[2] === 'new' && !reminder[3] || isUUID(reminder[2]))) return value
  const billing = /^\/app\/clients\/([^/]+)\/billing(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(value)
  if (billing && isUUID(billing[1]) && (!billing[2] || billing[2] === 'new' && !billing[3] || isUUID(billing[2]))) return value
  const pricing = /^\/app\/clients\/([^/]+)\/pricing(?:\/(new|[^/]+)(?:\/(new-version)|\/versions\/([^/]+))?)?$/.exec(value)
  if (pricing && isUUID(pricing[1]) && (!pricing[2] || pricing[2] === 'new' && !pricing[3] && !pricing[4] || isUUID(pricing[2]) && (!pricing[4] || isUUID(pricing[4])))) return value
  const plan = /^\/app\/clients\/([^/]+)\/plans(?:\/(new|[^/]+)(?:\/(edit|milestones)(?:\/(new|[^/]+)(?:\/(edit))?)?)?)?$/.exec(value)
  if (!plan || !isUUID(plan[1])) return '/app'
  if (!plan[2]) return value
  if (plan[2] === 'new') return !plan[3] ? value : '/app'
  if (!isUUID(plan[2]) || plan[3] === 'edit' && plan[4]) return '/app'
  if (!plan[4]) return value
  return plan[3] === 'milestones' && (plan[4] === 'new' && !plan[5] || isUUID(plan[4])) ? value : '/app'
}
