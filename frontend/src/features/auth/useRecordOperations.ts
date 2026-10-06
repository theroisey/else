import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from './auth-context'
import { APIError } from '../../services/authenticated'
import { sessionKey } from './session'
import type { Session } from './session'

// Domain records share actor/grant checks and a partitioned query lifecycle.
export function useRecordOperations(domain: 'clients' | 'tasks' | 'planning' | 'reminders' | 'activity' | 'audit' | 'billing' | 'pricing' | 'overview' | 'integrations' | 'analytics' | 'commerce' | 'marketing', scope?: string) {
  const auth = useAuth()
  const cache = useQueryClient()
  const actor = auth.session?.user.id
  const grants = JSON.stringify(auth.session?.user.permissions ?? [])
  const key = [domain, actor, grants, ...(scope ? [scope] : [])] as const
  const active = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  async function read<T>(load: () => Promise<T>) {
    try {
      const result = await load()
      if (!mounted.current) throw new APIError(0, 'context_changed')
      const current = cache.getQueryData<{ session: Session | null }>(sessionKey)?.session
      if (!current || current.user.id !== actor) throw new APIError(401, 'authentication_required')
      if (JSON.stringify(current.user.permissions) !== grants)
        throw new APIError(403, 'permission_denied')
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
    setErrorCode('')
    try {
      const result = await read(action)
      await cache.invalidateQueries({ queryKey: [domain, actor] })
      return result
    } catch (failure) {
      setError(
        failure instanceof APIError
          ? failure.message
          : 'Unable to complete this request. Try again.',
      )
      setErrorCode(failure instanceof APIError ? failure.code : 'request_failed')
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
    errorCode,
    clearError: () => {
      setError('')
      setErrorCode('')
    },
  }
}
