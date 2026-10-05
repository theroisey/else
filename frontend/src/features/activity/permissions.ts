import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
import type { ActivityEvent } from './models'

export function activityPermissions(
  grants: readonly Grant[],
  clientID: string,
) {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view = has('clients.view') && has('activity.view')
  const taskView = has('tasks.view'),
    planningView = has('planning.view'),
    reminderView = has('reminders.view')
  return {
    view,
    taskView,
    planningView,
    reminderView,
    allows: (event: ActivityEvent) =>
      view &&
      event.client_id === clientID.toLowerCase() &&
      (event.resource_kind === 'client' ||
        event.resource_kind === 'website' ||
        (event.resource_kind === 'task' && taskView) ||
        ((event.resource_kind === 'plan' ||
          event.resource_kind === 'milestone') &&
          planningView) ||
        (event.resource_kind === 'reminder' && reminderView)),
  }
}
