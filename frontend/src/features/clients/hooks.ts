import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-context'
import { APIError } from '../../services/authenticated'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'

export function useClients() {
  const auth = useAuth()
  const cache = useQueryClient()
  const key = [
    'clients',
    auth.session?.user.id,
    JSON.stringify(auth.session?.user.permissions ?? []),
  ] as const
  const active = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function read<T>(load: () => Promise<T>) {
    try {
      const result = await load()
      if (
        cache.getQueryData<{ session: Session | null }>(sessionKey)?.session?.user.id !==
        auth.session?.user.id
      )
        throw new APIError(401, 'authentication_required')
      return result
    } catch (failure) {
      if (failure instanceof APIError && [401, 403, 404].includes(failure.status))
        await auth.refresh()
      throw failure
    }
  }
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined
    active.current = true
    setPending(true)
    setError('')
    try {
      const result = await read(action)
      await cache.invalidateQueries({
        queryKey: ['clients', auth.session?.user.id],
      })
      return result
    } catch (failure) {
      setError(
        failure instanceof APIError
          ? failure.message
          : 'Unable to complete this request. Try again.',
      )
      return undefined
    } finally {
      active.current = false
      setPending(false)
    }
  }
  return {
    auth,
    cache,
    key,
    read,
    run,
    pending,
    error,
    clearError: () => setError(''),
  }
}
