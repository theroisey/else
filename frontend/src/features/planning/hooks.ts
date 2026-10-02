import { useQuery } from '@tanstack/react-query'
import { useRecordOperations } from '../auth/useRecordOperations'
import { planningPermissions } from './permissions'
import { recordKey, terminal } from './models'
import type { Scope } from './models'
import * as clients from '../clients/service'
import * as api from './service'
export function usePlanning(scope: Scope) {
  const operation = useRecordOperations('planning', scope.clientID)
  const permissions = planningPermissions(
    operation.auth.session?.user.permissions ?? [],
    scope.clientID,
  )
  const client = useQuery({
    queryKey: [...operation.key, 'client-context'],
    queryFn: ({ signal }) => operation.read(() => clients.client(scope.clientID, signal)),
    enabled: permissions.view && permissions.clientView,
  })
  const parent = useQuery({
    queryKey: [...operation.key, ...recordKey({ clientID: scope.clientID }, scope.planID ?? '')],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail({ clientID: scope.clientID }, scope.planID!, signal)),
    enabled: permissions.view && !!scope.planID,
  })
  return {
    ...operation,
    scope,
    permissions,
    client,
    parent,
    writable:
      (!permissions.clientView ||
        (!client.isError && !client.isFetching && client.data?.status === 'active')) &&
      (!scope.planID ||
        (!parent.isError &&
          !parent.isFetching &&
          !!parent.data &&
          !parent.data.archived_at &&
          !terminal(parent.data.status))),
  }
}
