import { useQuery } from '@tanstack/react-query'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
import * as clients from '../clients/service'
export function billingPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
      hasPermission(grants, { permission, scope: 'client', clientID }),
    view = has('billing.view')
  return {
    view,
    create: view && has('billing.create'),
    update: view && has('billing.update'),
    cancel: view && has('billing.delete'),
    clientView: has('clients.view'),
    taskView: has('tasks.view'),
    planningView: has('planning.view'),
    reminderView: has('reminders.view'),
    activityView: has('clients.view') && has('activity.view'),
    auditView:
      has('clients.view') &&
      hasPermission(grants, { permission: 'audit.view', scope: 'global' }),
  }
}
export function useBilling(clientID: string) {
  const operation = useRecordOperations('billing', clientID),
    permissions = billingPermissions(
      operation.auth.session?.user.permissions ?? [],
      clientID,
    )
  const client = useQuery({
    queryKey: [...operation.key, 'client-context'],
    queryFn: ({ signal }) =>
      operation.read(() => clients.client(clientID, signal)),
    enabled: permissions.view && permissions.clientView,
  })
  return {
    ...operation,
    clientID,
    permissions,
    client,
    writable:
      !permissions.clientView ||
      (!client.isError &&
        !client.isFetching &&
        client.data?.status === 'active'),
  }
}
