import { useLocale } from '../../i18n/index'
import { applyAccountLocale } from '../../i18n/preferences'
import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthContext } from './auth-context'
import * as service from './auth-service'
import { sessionKey } from './session'
import type { Session } from './session'

interface IdentityState {
  session: Session | null
  expired: boolean
}

export function AuthProvider({ children }: { children: ReactNode }) {
  useLocale()
  const client = useQueryClient()
  const hadSession = useRef(false)
  const query = useQuery({
    queryKey: sessionKey,
    queryFn: async ({ signal }): Promise<IdentityState> => {
      const session = await service.currentSession(signal)
      const expired = !session && hadSession.current
      if (session) hadSession.current = true
      return { session, expired }
    },
    retry: false,
    staleTime: 30_000,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  })

  const forgetSession = useCallback(
    async (expired: boolean) => {
      await client.cancelQueries()
      client.removeQueries({
        predicate: (entry) => entry.queryKey[0] !== 'auth',
      })
      hadSession.current = false
      client.setQueryData<IdentityState>(sessionKey, {
        session: null,
        expired,
      })
    },
    [client],
  )

  const session = query.isError ? null : (query.data?.session ?? null)
  const preferenceUser = session?.user.id
  useEffect(() => {
    if (!preferenceUser) return
    const controller = new AbortController()
    void applyAccountLocale(controller.signal).catch(() => {
      /* Keep the local/browser fallback; selectors report save failures. */
    })
    return () => controller.abort()
  }, [preferenceUser])
  useEffect(() => {
    if (!session) {
      client.removeQueries({
        predicate: (entry) => entry.queryKey[0] !== 'auth',
      })
      return
    }
    const timer = window.setTimeout(
      () => {
        void forgetSession(true)
      },
      Math.max(0, Date.parse(session.session.expires_at) - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [client, forgetSession, session])

  async function login(email: string, password: string) {
    // Avoid placing passwords in a mutation cache or browser persistence.
    await client.cancelQueries({ queryKey: sessionKey })
    const identity = await service.login(email, password)
    await client.cancelQueries()
    client.removeQueries({
      predicate: (entry) => entry.queryKey[0] !== 'auth',
    })
    hadSession.current = true
    client.setQueryData<IdentityState>(sessionKey, {
      session: identity,
      expired: false,
    })
  }

  async function logout() {
    // A failed logout keeps the real session visible; never claim revocation succeeded.
    await service.logout()
    await forgetSession(false)
  }

  return (
    <AuthContext
      value={{
        status: query.isPending
          ? 'checking'
          : query.isError
            ? 'unavailable'
            : session
              ? 'signed-in'
              : 'signed-out',
        session,
        expired: query.data?.expired ?? false,
        login,
        logout,
        refresh: async () => {
          await query.refetch()
        },
      }}
    >
      {children}
    </AuthContext>
  )
}
