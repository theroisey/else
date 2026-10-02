import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
export function taskPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view = has('tasks.view'),
    manage = has('tasks.manage')
  return {
    view,
    create: view && (has('tasks.create') || manage),
    update: view && (has('tasks.update') || manage),
    archive: view && (has('tasks.delete') || manage),
    clientView: has('clients.view'),
  }
}
