import { useQuery } from '@tanstack/react-query'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { integrationPermissions } from './permissions'
import * as clients from '../clients/service'

export function useIntegrations(clientID: string) {
  const operation = useRecordOperations('integrations', clientID)
  const permissions = integrationPermissions(
    operation.auth.session?.user.permissions ?? [],
    clientID,
  )
  return { ...operation, permissions, clientID }
}
export type Operation = ReturnType<typeof useIntegrations>
export function useIntegrationClient(operation: Operation) {
  return useQuery({
    queryKey: [...operation.key, 'client'],
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) =>
      operation.read(async () => {
        const client = await clients.client(operation.clientID, signal)
        if (client.id !== operation.clientID)
          throw new APIError(0, 'invalid_response')
        return client
      }),
  })
}
