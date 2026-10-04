import { hasPermission } from '../auth/permissions'
import { useRecordOperations } from '../auth/useRecordOperations'

export function useMarketing(clientID: string) {
  const operation = useRecordOperations('marketing', clientID)
  const grants = operation.auth.session?.user.permissions ?? []
  const has = (permission: string) => hasPermission(grants, { permission, scope: 'client', clientID })
  return { ...operation, clientID, permissions: { view: has('clients.view') && has('analytics.view'), integrations: has('clients.view') && has('integrations.view') } }
}
