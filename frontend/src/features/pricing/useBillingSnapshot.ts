import { useQuery } from '@tanstack/react-query'
import { APIError } from '../../services/authenticated'
import type { Operation } from '../billing/Shared'
import type { Collection } from '../billing/models'
import * as api from './service'
export function useBillingSnapshot(op: Operation, record?: Collection) {
  return useQuery({
    queryKey: [...op.key, 'pricing-snapshot', record?.id ?? ''],
    queryFn: ({ signal }) =>
      op.read(async () => {
        if (!record) throw new APIError(0, 'invalid_request')
        const s = await api.snapshot(op.clientID, record.id, signal)
        if (
          s &&
          (s.currency !== record.currency ||
            s.total_minor !== record.amount_minor)
        )
          throw new APIError(0, 'invalid_response')
        return s
      }),
    enabled: op.permissions.view && !!record,
  })
}
