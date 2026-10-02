import { useQuery } from '@tanstack/react-query'
import { useRecordOperations } from '../auth/useRecordOperations'
import { reminderPermissions } from './permissions'
import * as clients from '../clients/service'
export function useReminders(clientID: string) {
  const operation = useRecordOperations('reminders', clientID),
    permissions = reminderPermissions(operation.auth.session?.user.permissions ?? [], clientID)
  const client = useQuery({
    queryKey: [...operation.key, 'client-context'],
    queryFn: ({ signal }) => operation.read(() => clients.client(clientID, signal)),
    enabled: permissions.view && permissions.clientView,
  })
  return {
    ...operation,
    clientID,
    permissions,
    client,
    writable:
      !permissions.clientView ||
      (!client.isError && !client.isFetching && client.data?.status === 'active'),
  }
}
