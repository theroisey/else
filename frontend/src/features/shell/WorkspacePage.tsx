import { currentLocale } from '../../i18n'
import { copy, useLocale } from '../../i18n/index'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight } from '@fortawesome/free-solid-svg-icons'
import { Link } from 'react-router'
import { Status, PageHeader, buttonStyles } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { hasPermission, canOpenClients } from '../auth/permissions'
import { visibleDestinations } from './navigation'

export function WorkspacePage() {
  useLocale()
  const { session } = useAuth()
  if (!session) return null
  const grants = session.user.permissions
  const administration = visibleDestinations(grants).filter((item) =>
    ['/app/users', '/app/roles', '/app/audit'].includes(
      item.path,
    ),
  )
  return (
    <section>
      <PageHeader
        eyebrow={copy('Private operations', 'common')}
        title={copy('Operations workspace', 'common')}
        description={copy(
          'Client relationships, financial clarity and considered execution. Select a client to open its dedicated workspace.',
          'common',
        )}
      />
      <div className="workspace-entry-grid">
        <div>
          {canOpenClients(grants) ? (
            <section
              className="workspace-entry"
              aria-labelledby="portfolio-title"
            >
              <p className="eyebrow">{copy('01 / Relationships', 'common')}</p>
              <h2 id="portfolio-title" className="mt-4 font-display text-3xl">
                {copy('Client portfolio', 'common')}
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-7 text-muted">
                {copy(
                  'A single dossier for each relationship. Review the work, plans, financial position and measured performance available to your account.',
                  'common',
                )}
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  className={buttonStyles({ variant: 'primary' })}
                  to="/app/clients"
                >
                  {copy('Open clients', 'common')}
                </Link>
                {hasPermission(grants, {
                  permission: 'clients.create',
                  scope: 'global',
                }) ? (
                  <Link
                    className={buttonStyles({ variant: 'text' })}
                    to="/app/clients/new"
                  >
                    {copy('Create client', 'common')}
                  </Link>
                ) : null}
              </div>
            </section>
          ) : (
            <section className="workspace-entry">
              <p className="eyebrow">{copy('Relationships', 'common')}</p>
              <h2 className="mt-4 font-display text-2xl">
                {copy('Client access is not assigned', 'common')}
              </h2>
              <p className="mt-3 text-muted">
                {copy(
                  'Review your effective permissions or contact your administrator for the access you need.',
                  'common',
                )}
              </p>
            </section>
          )}
          {administration.length ? (
            <section className="mt-8 border-t border-line pt-6">
              <p className="eyebrow">{copy('02 / Governance', 'common')}</p>
              <div className="mt-4 grid gap-0 sm:grid-cols-2">
                {administration.map((item) => (
                  <Link
                    className="workspace-destination"
                    key={item.path}
                    to={item.path}
                  >
                    <span>{copy(item.label, 'common')}</span>
                    <FontAwesomeIcon
                      className="text-[0.625rem] text-muted"
                      icon={faArrowRight}
                      aria-hidden="true"
                    />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <aside className="context-rail" aria-labelledby="session-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="session-heading" className="eyebrow">
              {copy('Current session', 'common')}
            </h2>
            <Status tone="success">{copy('Signed in', 'common')}</Status>
          </div>
          <p className="mt-6 break-words text-base font-medium">
            {session.user.display_name}
          </p>
          <p className="mt-2 break-all text-xs text-muted">
            {session.user.email}
          </p>
          <dl className="mt-6 border-t border-line pt-5">
            <dt className="eyebrow">{copy('Session ends', 'common')}</dt>
            <dd className="mt-2 text-sm">
              <time dateTime={session.session.expires_at}>
                {new Date(session.session.expires_at).toLocaleString(
                  currentLocale(),
                  { dateStyle: 'medium', timeStyle: 'short' },
                )}
              </time>
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted">
            {copy('Shown in your device’s timezone.', 'common')}
          </p>
          <Link
            className="mt-6 block text-xs underline underline-offset-4"
            to="/app/access"
          >
            {copy('Review my access', 'common')}
          </Link>
          <p className="mt-6 border-t border-line pt-5 text-xs leading-6 text-muted">
            {copy(
              'Navigation reflects your effective access. Every protected operation is verified by the server.',
              'common',
            )}
          </p>
        </aside>
      </div>
    </section>
  )
}
