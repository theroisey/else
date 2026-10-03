import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'

export function integrationPermissions(
  grants: readonly Grant[],
  clientID: string,
) {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view = has('clients.view') && has('integrations.view')
  return { view, manage: view && has('integrations.manage') }
}
