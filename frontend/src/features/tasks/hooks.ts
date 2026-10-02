import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRecordOperations } from '../auth/useRecordOperations'
import { taskPermissions } from './permissions'
import * as clients from '../clients/service'

export function useTasks(clientID: string) {
  const operation = useRecordOperations('tasks', clientID)
  const permissions = taskPermissions(operation.auth.session?.user.permissions ?? [], clientID)
  const parent = useQuery({
    queryKey: [...operation.key, 'client-context'],
    queryFn: ({ signal }) => operation.read(() => clients.client(clientID, signal)),
    enabled: permissions.view && permissions.clientView,
  })
  return {
    ...operation,
    permissions,
    parent,
    writable:
      !permissions.clientView ||
      (!parent.isError && !parent.isFetching && parent.data?.status === 'active'),
  }
}
export function useDueClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = window.setInterval(update, 30_000)
    window.addEventListener('focus', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
    }
  }, [])
  return now
}
