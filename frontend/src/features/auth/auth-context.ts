import { createContext, useContext } from 'react'
import type { Session } from './session'

export interface AuthState {
  status: 'checking' | 'signed-in' | 'signed-out' | 'unavailable'
  session: Session | null
  expired: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth() {
  const state = useContext(AuthContext)
  if (!state) throw new Error('Authentication context is missing.')
  return state
}
