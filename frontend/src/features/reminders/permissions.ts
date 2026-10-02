import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
export function reminderPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
      hasPermission(grants, { permission, scope: 'client', clientID }),
    view = has('reminders.view')
  return {
    view,
    create: view && has('reminders.create'),
    update: view && has('reminders.update'),
    clientView: has('clients.view'),
    activityView: has('clients.view') && has('activity.view'),
    taskView: has('tasks.view'),
    planningView: has('planning.view'),
  }
}
