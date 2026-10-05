import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { Link } from 'react-router'
import { Status, PageHeader, buttonStyles } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { hasPermission, canOpenClients } from '../auth/permissions'
import { visibleDestinations } from './navigation'

export function WorkspacePage() {
  const { session } = useAuth()
  if (!session) return null
  const grants = session.user.permissions
  const administration = visibleDestinations(grants).filter(item => ['/app/users', '/app/roles', '/app/audit', '/app/releases'].includes(item.path))
  return <section>
    <PageHeader eyebrow="Private operations" title="Operations workspace" description="Client relationships, financial clarity and considered execution. Select a client to open its dedicated workspace." />
    <div className="workspace-entry-grid"><div>
      {canOpenClients(grants) ? <section className="workspace-entry" aria-labelledby="portfolio-title"><p className="eyebrow">01 / Relationships</p><h2 id="portfolio-title" className="mt-4 font-display text-3xl">Client portfolio</h2><p className="mt-3 max-w-lg text-sm leading-7 text-muted">A single dossier for each relationship. Review the work, plans, financial position and measured performance available to your account.</p><div className="mt-6 flex flex-wrap gap-3"><Link className={buttonStyles({ variant: 'primary' })} to="/app/clients">Open clients</Link>{hasPermission(grants, { permission: 'clients.create', scope: 'global' }) ? <Link className={buttonStyles({ variant: 'text' })} to="/app/clients/new">Create client</Link> : null}</div></section> : <section className="workspace-entry"><p className="eyebrow">Relationships</p><h2 className="mt-4 font-display text-2xl">Client access is not assigned</h2><p className="mt-3 text-muted">Review your effective permissions or contact your administrator for the access you need.</p></section>}
      {administration.length ? <section className="mt-8 border-t border-line pt-6"><p className="eyebrow">02 / Governance</p><div className="mt-4 grid gap-0 sm:grid-cols-2">{administration.map(item => <Link className="workspace-destination" key={item.path} to={item.path}><span>{item.label}</span><FontAwesomeIcon className="text-[0.625rem] text-muted" icon={faArrowRight} aria-hidden="true" /></Link>)}</div></section> : null}
    </div><aside className="context-rail" aria-labelledby="session-heading"><div className="flex items-center justify-between gap-3"><h2 id="session-heading" className="eyebrow">Current session</h2><Status tone="success">Signed in</Status></div><p className="mt-6 break-words text-base font-medium">{session.user.display_name}</p><p className="mt-2 break-all text-xs text-muted">{session.user.email}</p><dl className="mt-6 border-t border-line pt-5"><dt className="eyebrow">Session ends</dt><dd className="mt-2 text-sm"><time dateTime={session.session.expires_at}>{new Date(session.session.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></dd></dl><p className="mt-2 text-xs text-muted">Shown in your device’s timezone.</p><Link className="mt-6 block text-xs underline underline-offset-4" to="/app/access">Review my access</Link><p className="mt-6 border-t border-line pt-5 text-xs leading-6 text-muted">Navigation reflects your effective access. Every protected operation is verified by the server.</p></aside></div>
  </section>
}
