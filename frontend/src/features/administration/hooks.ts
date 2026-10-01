import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context'
import * as api from './service'

export function useAdministration() {
  const auth = useAuth()
  const client = useQueryClient()
  const [pending, setPending] = useState(false)
  const active = useRef(false)
  const [error, setError] = useState('')
  async function read<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load()
    } catch (failure) {
      if (
        failure instanceof api.AdministrationError &&
        (failure.status === 401 || failure.status === 403)
      )
        await auth.refresh()
      throw failure
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (active.current) return false
    active.current = true
    setPending(true)
    setError('')
    try {
      await read(action)
      await client.invalidateQueries({ queryKey: ['administration'] })
      await auth.refresh()
      return true
    } catch (failure) {
      setError(
        failure instanceof api.AdministrationError
          ? failure.message
          : 'Unable to complete this request. Try again.',
      )
      return false
    } finally {
      active.current = false
      setPending(false)
    }
  }
  return { auth, client, read, run, pending, error, clearError: () => setError('') }
}
export function useCursor() {
  const [history, setHistory] = useState([''])
  return {
    cursor: history.at(-1) ?? '',
    previous: history.length > 1,
    back: () => setHistory((h) => h.slice(0, -1)),
    next: (cursor: string) => setHistory((h) => [...h, cursor]),
    reset: () => setHistory(['']),
  }
}
export function useCatalog() {
  const { auth, read } = useAdministration()
  return useQuery({
    queryKey: ['administration', auth.session?.user.id, 'permissions'],
    queryFn: ({ signal }) => read(() => api.catalog(signal)),
  })
}
