import { useQuery } from '@tanstack/react-query'
import { useRef } from 'react'
import { hasPermission } from '../auth/permissions'
import { useRecordOperations } from '../auth/useRecordOperations'
import { readReleaseReport } from './service'

export function useReleaseReport() {
  const operation = useRecordOperations('releases')
  const manual = useRef(false)
  const allowed = hasPermission(
    operation.auth.session?.user.permissions ?? [],
    { permission: 'releases.view', scope: 'global' },
  )
  const query = useQuery({
    queryKey: [...operation.key, 'current'],
    queryFn: ({ signal }) => {
      const revalidate = manual.current
      manual.current = false
      return operation.read(() => readReleaseReport(signal, revalidate))
    },
    enabled: allowed,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
  return {
    allowed,
    query,
    refresh: async () => {
      if (!allowed || query.isFetching) return
      manual.current = true
      await query.refetch()
    },
  }
}
