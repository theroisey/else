import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Button } from '../../components/ui'
import { useAuth } from './auth-context'
import { hasPermission } from './permissions'
import type { PermissionRequirement } from './permissions'

export function AuthGuard() {
  const auth = useAuth()
  const location = useLocation()
  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (auth.status === 'signed-out') return <Navigate to="/login" replace state={{ returnTo: location.pathname }} />
  return <Outlet />
}

export function AuthPending() {
  return <main className="mx-auto max-w-lg px-6 py-16" aria-busy="true"><p role="status">Checking your session…</p></main>
}

export function AuthUnavailable() {
  const auth = useAuth()
  return <main className="mx-auto max-w-lg px-6 py-16">
    <p className="eyebrow">Roisey Else</p>
    <h1 className="mt-3 text-2xl font-semibold">Session check unavailable</h1>
    <p className="mt-3 text-muted" role="alert">We could not verify your session. Try again before continuing.</p>
    <Button className="mt-6" onClick={() => { void auth.refresh() }}>Try again</Button>
  </main>
}

export function PermissionGuard({ required, children }: { required: PermissionRequirement; children: ReactNode }) {
  const auth = useAuth()
  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (!auth.session || !hasPermission(auth.session.user.permissions, required)) return <section>
    <h1 className="text-2xl font-semibold">Access denied</h1>
    <p className="mt-3 text-muted" role="alert">Your current permissions do not allow this page.</p>
  </section>
  return children
}
