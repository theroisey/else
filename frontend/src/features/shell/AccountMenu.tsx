import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { faArrowRightFromBracket } from '@fortawesome/free-solid-svg-icons'
import { Button } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { AuthError } from '../auth/auth-service'

export function AccountMenu() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function signOut() {
    if (pending) return
    setPending(true)
    setError('')
    try {
      await auth.logout()
      navigate('/login', { replace: true })
    } catch (failure) {
      setError(failure instanceof AuthError ? failure.message : 'Unable to sign out. Try again.')
    } finally {
      setPending(false)
    }
  }

  return <details className="relative min-w-0 max-w-48" onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.currentTarget.open = false
      event.currentTarget.querySelector('summary')?.focus()
    }
  }}>
    <summary className="flex min-h-10 max-w-48 cursor-pointer list-none items-center gap-2 rounded-sm border border-line bg-surface px-3 font-semibold hover:border-ink" aria-label="Account">
      <span className="truncate">{auth.session?.user.display_name}</span><span className="text-muted" aria-hidden="true">⌄</span>
    </summary>
    <div className="absolute right-0 z-20 mt-2 grid w-[min(20rem,calc(100vw-2rem))] gap-3 rounded-md border border-line bg-surface p-4 shadow-dialog">
      <p className="break-all text-sm text-muted">{auth.session?.user.email}</p>
      <Link className="min-h-8 py-1 font-semibold underline underline-offset-4" to="/app/access" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open') }}>My access</Link>
      <Button icon={faArrowRightFromBracket} loading={pending} loadingLabel="Signing out" onClick={() => { void signOut() }}>Sign out</Button>
      {error ? <p className="text-sm leading-6 text-danger-ink" role="alert">{error}</p> : null}
    </div>
  </details>
}
