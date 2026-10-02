import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
import type { Summary } from './models'
export function auditPermissions(grants: readonly Grant[], clientID?: string) {
  const root = hasPermission(grants, {
    permission: 'audit.view',
    scope: 'global',
  })
  const clientView = (id: string) =>
    hasPermission(grants, {
      permission: 'clients.view',
      scope: 'client',
      clientID: id,
    })
  const view = root && (!clientID || clientView(clientID))
  return {
    view,
    clientView,
    allows: (row: Summary) =>
      view &&
      (!clientID || row.client_id === clientID) &&
      (row.client_id === null || clientView(row.client_id)),
  }
}
