import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
export function planningPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view = has('planning.view')
  return {
    view,
    create: view && has('planning.create'),
    update: view && has('planning.update'),
    archive: view && has('planning.archive'),
    taskView: has('tasks.view'),
    clientView: has('clients.view'),
  }
}
