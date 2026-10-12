import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
export function taskPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view =
      has('tasks.view') ||
      has('tasks.read_own') ||
      has('tasks.read_team') ||
      has('tasks.read_development'),
    manage = has('tasks.manage')
  return {
    view,
    assignTeam: view && has('tasks.assign_team'),
    updateOwn: view && has('tasks.update_own'),
    create: view && (has('tasks.create') || manage),
    update: view && (has('tasks.update') || manage),
    archive: view && (has('tasks.delete') || manage),
    clientView: has('clients.view'),
    activityView: has('clients.view') && has('activity.view'),
    reminderView: has('reminders.view'),
    planningView: has('planning.view'),
  }
}
