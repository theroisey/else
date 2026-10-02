import { useQuery } from '@tanstack/react-query'
import { hasPermission } from '../auth/permissions'
import type { Grant } from '../auth/session'
import { useRecordOperations } from '../auth/useRecordOperations'
import * as clients from '../clients/service'
export function pricingPermissions(grants: readonly Grant[], clientID: string) {
  const has = (permission: string) =>
      hasPermission(grants, { permission, scope: 'client', clientID }),
    view = has('pricing.view')
  return {
    view,
    manage: view && has('pricing.manage'),
    copy: view && has('billing.view') && has('billing.create'),
    clientView: has('clients.view'),
    billingView: has('billing.view'),
  }
}
export function usePricing(clientID: string) {
  const operation = useRecordOperations('pricing', clientID),
    permissions = pricingPermissions(
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
