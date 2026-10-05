import { copy, useLocale } from '../../i18n/index'
import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Button } from '../../components/ui'
import { useAuth } from './auth-context'
import { hasPermission } from './permissions'
import type { PermissionRequirement } from './permissions'

export function AuthGuard() {
  useLocale()
  const auth = useAuth()
  const location = useLocation()
  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (auth.status === 'signed-out')
    return (
      <Navigate to="/login" replace state={{ returnTo: location.pathname }} />
    )
  return <Outlet />
}

export function AuthPending() {
  useLocale()
  return (
    <main className="mx-auto max-w-lg px-6 py-16" aria-busy="true">
      <p role="status">{copy('Checking your session…', 'auth')}</p>
    </main>
  )
}

export function AuthUnavailable() {
  useLocale()
  const auth = useAuth()
  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <p className="eyebrow">Roisey Else</p>
      <h1 className="page-title">
        {copy('Session check unavailable', 'auth')}
      </h1>
      <p className="mt-3 text-muted" role="alert">
        {copy(
          'We could not verify your session. Try again before continuing.',
          'auth',
        )}
      </p>
      <Button
        className="mt-6"
        onClick={() => {
          void auth.refresh()
        }}
      >
        {copy('Try again', 'auth')}
      </Button>
    </main>
  )
}

export function PermissionGuard({
  required,
  children,
}: {
  required: PermissionRequirement
  children: ReactNode
}) {
  useLocale()
  const auth = useAuth()
  if (auth.status === 'checking') return <AuthPending />
  if (auth.status === 'unavailable') return <AuthUnavailable />
  if (!auth.session || !hasPermission(auth.session.user.permissions, required))
    return (
      <section>
        <h1 className="page-title">{copy('Access denied', 'auth')}</h1>
        <p className="mt-3 text-muted" role="alert">
          {copy('Your current permissions do not allow this page.', 'auth')}
        </p>
      </section>
    )
  return children
}
