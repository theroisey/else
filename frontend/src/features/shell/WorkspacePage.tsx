import { Link } from 'react-router'
import { Status, buttonStyles } from '../../components/ui'
import { useAuth } from '../auth/auth-context'

export function WorkspacePage() {
  const { session } = useAuth()
  if (!session) return null
  return <section className="max-w-4xl">
    <p className="eyebrow">Workspace</p>
    <h1 className="mt-3 break-words text-3xl font-semibold tracking-tight">Welcome, {session.user.display_name}</h1>
    <p className="mt-3 max-w-xl leading-6 text-muted">Your account is signed in. Review your current access or check service availability.</p>
    <div className="mt-7 rounded-md border border-line bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Current session</h2><Status tone="success">Signed in</Status></div>
      <dl className="mt-5 grid gap-5 sm:grid-cols-2">
        <div><dt className="text-xs text-muted">Account</dt><dd className="mt-1 break-all font-medium">{session.user.email}</dd></div>
        <div><dt className="text-xs text-muted">Session ends</dt><dd className="mt-1 font-medium"><time dateTime={session.session.expires_at}>{new Date(session.session.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time><span className="mt-1 block text-xs font-normal text-muted">Shown in your device’s timezone.</span></dd></div>
      </dl>
      <Link className={buttonStyles({ className: 'mt-6' })} to="/app/access">Review my access</Link>
    </div>
    <p className="mt-5 text-sm leading-6 text-muted">Only available pages appear in navigation. Business modules will appear as they become available to your account.</p>
  </section>
}
