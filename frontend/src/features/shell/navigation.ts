import {
  faHouse,
  faShieldHalved,
  faUsers,
  faUserShield,
  faBuilding,
  faClockRotateLeft,
} from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { hasPermission } from '../auth/permissions'
import type { PermissionRequirement } from '../auth/permissions'
import type { Grant } from '../auth/session'
import { isUUID } from '../auth/session'
import { canOpenClients } from '../auth/permissions'

export interface Destination {
  path: string
  label: string
  icon: IconDefinition
  required?: PermissionRequirement
  visible?: (grants: readonly Grant[]) => boolean
}

// Register a destination only when its page and backend contract exist.
export const destinations: readonly Destination[] = [
  { path: '/app', label: 'Today', icon: faHouse },
  {
    path: '/app/tasks',
    label: 'Task queue',
    icon: faClockRotateLeft,
    visible: (grants) =>
      grants.some((g) =>
        [
          'tasks.view',
          'tasks.read_own',
          'tasks.read_team',
          'tasks.read_development',
        ].includes(g.permission),
      ),
  },
  {
    path: '/app/requests',
    label: 'Technical requests',
    icon: faBuilding,
    visible: (grants) =>
      grants.some((g) =>
        ['tickets.read_own', 'tickets.read_team', 'tickets.read_all'].includes(
          g.permission,
        ),
      ),
  },
  {
    path: '/app/notifications',
    label: 'Notifications',
    icon: faClockRotateLeft,
  },
  {
    path: '/app/finance',
    label: 'Finance',
    icon: faBuilding,
    visible: (grants) =>
      grants.some((g) => g.permission === 'finance.read_company'),
  },
  {
    path: '/app/team',
    label: 'Team',
    icon: faUsers,
    visible: (grants) =>
      grants.some(
        (g) =>
          g.scope === 'global' &&
          ['staff.read_team', 'staff.manage'].includes(g.permission),
      ),
  },
  { path: '/app/portfolio', label: 'Portfolio', icon: faBuilding },
  { path: '/app/settings', label: 'Settings', icon: faShieldHalved },
  { path: '/app/access', label: 'My access', icon: faShieldHalved },
  {
    path: '/app/clients',
    label: 'Clients',
    icon: faBuilding,
    visible: canOpenClients,
  },
  {
    path: '/app/users',
    label: 'Users',
    icon: faUsers,
    required: { permission: 'users.view', scope: 'global' },
  },
  {
    path: '/app/roles',
    label: 'Roles',
    icon: faUserShield,
    required: { permission: 'roles.view', scope: 'global' },
  },
  {
    path: '/app/audit',
    label: 'Audit history',
    icon: faClockRotateLeft,
    required: { permission: 'audit.view', scope: 'global' },
  },
]

export function visibleDestinations(
  grants: readonly Grant[],
  registered = destinations,
) {
  return registered.filter(
    (destination) =>
      (!destination.required || hasPermission(grants, destination.required)) &&
      (!destination.visible || destination.visible(grants)),
  )
}

export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string') return '/app'
  if (
    destinations.some((destination) => destination.path === value) ||
    value === '/app/clients/new' ||
    value === '/app/requests/new'
  )
    return value
  const recurring =
    /^\/app\/clients\/([^/]+)\/recurring-tasks(?:\/([^/]+))?$/.exec(value)
  if (
    recurring &&
    isUUID(recurring[1]) &&
    (!recurring[2] || isUUID(recurring[2]))
  )
    return value
  const finance = /^\/app\/clients\/([^/]+)\/finance(?:\/([^/]+))?$/.exec(value)
  if (finance && isUUID(finance[1]) && (!finance[2] || isUUID(finance[2])))
    return value
  if (value === '/app/finance') return value
  const team = /^\/app\/team\/([^/]+)$/.exec(value)
  if (team && isUUID(team[1])) return value
  const siteRequest =
    /^\/app\/clients\/([^/]+)\/websites\/([^/]+)\/requests\/new$/.exec(value)
  if (siteRequest && isUUID(siteRequest[1]) && isUUID(siteRequest[2]))
    return value
  const request = /^\/app\/clients\/([^/]+)\/requests(?:\/(new|[^/]+))?$/.exec(
    value,
  )
  if (
    request &&
    isUUID(request[1]) &&
    (!request[2] || request[2] === 'new' || isUUID(request[2]))
  )
    return value
  const match = /^\/app\/clients\/([^/]+)(?:\/(edit|profile))?$/.exec(value)
  if (match && isUUID(match[1])) return value
  const website =
    /^\/app\/clients\/([^/]+)\/websites(?:\/([^/]+)(?:\/(analytics|commerce|marketing|integrations|activity)(?:\/([^/]+))?)?)?$/.exec(
      value,
    )
  if (
    website &&
    isUUID(website[1]) &&
    (!website[2] || isUUID(website[2])) &&
    (!website[4] || (website[3] !== 'activity' && isUUID(website[4])))
  )
    return value
  const activity = /^\/app\/clients\/([^/]+)\/activity$/.exec(value)
  if (activity && isUUID(activity[1])) return value
  const integration =
    /^\/app\/clients\/([^/]+)\/integrations(?:\/([^/]+))?$/.exec(value)
  if (
    integration &&
    isUUID(integration[1]) &&
    (!integration[2] || isUUID(integration[2]))
  )
    return value
  const analytics = /^\/app\/clients\/([^/]+)\/analytics(?:\/([^/]+))?$/.exec(
    value,
  )
  if (
    analytics &&
    isUUID(analytics[1]) &&
    (!analytics[2] || isUUID(analytics[2]))
  )
    return value
  const commerce = /^\/app\/clients\/([^/]+)\/commerce(?:\/([^/]+))?$/.exec(
    value,
  )
  if (commerce && isUUID(commerce[1]) && (!commerce[2] || isUUID(commerce[2])))
    return value
  const marketing = /^\/app\/clients\/([^/]+)\/marketing(?:\/([^/]+))?$/.exec(
    value,
  )
  if (
    marketing &&
    isUUID(marketing[1]) &&
    (!marketing[2] || isUUID(marketing[2]))
  )
    return value
  const audit = /^\/app\/clients\/([^/]+)\/audit$/.exec(value)
  if (audit && isUUID(audit[1])) return value
  const task =
    /^\/app\/clients\/([^/]+)\/tasks(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(
      value,
    )
  if (
    task &&
    isUUID(task[1]) &&
    (!task[2] || (task[2] === 'new' && !task[3]) || isUUID(task[2]))
  )
    return value
  const reminder =
    /^\/app\/clients\/([^/]+)\/reminders(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(
      value,
    )
  if (
    reminder &&
    isUUID(reminder[1]) &&
    (!reminder[2] ||
      (reminder[2] === 'new' && !reminder[3]) ||
      isUUID(reminder[2]))
  )
    return value
  const billing =
    /^\/app\/clients\/([^/]+)\/billing(?:\/(new|[^/]+)(?:\/(edit))?)?$/.exec(
      value,
    )
  if (
    billing &&
    isUUID(billing[1]) &&
    (!billing[2] || (billing[2] === 'new' && !billing[3]) || isUUID(billing[2]))
  )
    return value
  const pricing =
    /^\/app\/clients\/([^/]+)\/pricing(?:\/(new|[^/]+)(?:\/(new-version)|\/versions\/([^/]+))?)?$/.exec(
      value,
    )
  if (
    pricing &&
    isUUID(pricing[1]) &&
    (!pricing[2] ||
      (pricing[2] === 'new' && !pricing[3] && !pricing[4]) ||
      (isUUID(pricing[2]) && (!pricing[4] || isUUID(pricing[4]))))
  )
    return value
  const plan =
    /^\/app\/clients\/([^/]+)\/plans(?:\/(new|[^/]+)(?:\/(edit|milestones)(?:\/(new|[^/]+)(?:\/(edit))?)?)?)?$/.exec(
      value,
    )
  if (!plan || !isUUID(plan[1])) return '/app'
  if (!plan[2]) return value
  if (plan[2] === 'new') return !plan[3] ? value : '/app'
  if (!isUUID(plan[2]) || (plan[3] === 'edit' && plan[4])) return '/app'
  if (!plan[4]) return value
  return plan[3] === 'milestones' &&
    ((plan[4] === 'new' && !plan[5]) || isUUID(plan[4]))
    ? value
    : '/app'
}
