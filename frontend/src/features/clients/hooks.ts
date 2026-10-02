import { useRecordOperations } from '../auth/useRecordOperations'
export function useClients() {
  return useRecordOperations('clients')
}
