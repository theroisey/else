import { useQuery } from '@tanstack/react-query'
import { hasPermission } from '../auth/permissions'
import { useRecordOperations } from '../auth/useRecordOperations'
import { readReleaseReport } from './service'

export function useReleaseReport() {
  const operation = useRecordOperations('releases')
  const allowed = hasPermission(operation.auth.session?.user.permissions ?? [], { permission: 'releases.view', scope: 'global' })
  const query = useQuery({
    queryKey: [...operation.key, 'current'],
    queryFn: ({ signal }) => operation.read(() => readReleaseReport(signal)),
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  return { allowed, query }
}
