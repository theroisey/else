import { Link } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, buttonStyles } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { labels } from './models'
import type { Connection } from './models'

export function IntegrationHeader({
  clientID,
  name,
  detail = false,
}: {
  clientID: string
  name?: string | undefined
  detail?: boolean
}) {
  return (
    <>
      <header className="mb-5">
        <p className="eyebrow">{name ?? 'Client workspace'} · Integrations</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {detail ? 'Integration connection' : 'Integrations'}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Recorded connection metadata. These states do not verify current
          provider access or synchronization. Times are shown in UTC.
        </p>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={`/app/clients/${clientID}`}
        >
          Overview
        </Link>
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={`/app/clients/${clientID}/profile`}
        >
          Profile
        </Link>
        {detail ? (
          <Link
            className={buttonStyles({ size: 'compact' })}
            to={`/app/clients/${clientID}/integrations`}
          >
            Integrations
          </Link>
        ) : (
          <span
            aria-current="page"
            className="self-center px-3 text-sm font-semibold"
          >
            Integrations
          </span>
        )}
      </nav>
    </>
  )
}
export function IntegrationState({ record }: { record: Connection }) {
  const attention = ['revocation_failed', 'reauthorization_required'].includes(
    record.state,
  )
  return (
    <Status tone={attention ? 'warning' : 'neutral'}>
      {labels[record.state]}
    </Status>
  )
}
export function ManualAction() {
  return (
    <aside
      aria-labelledby="manual-revocation"
      className="mt-5 rounded-md border border-warning-line bg-warning-surface p-4 text-warning-ink"
    >
      <h2
        id="manual-revocation"
        className="flex items-center gap-2 font-semibold"
      >
        <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden="true" />
        Remote revocation requires manual action
      </h2>
      <p className="mt-2 text-sm leading-6">
        Local credential use is disabled. Remote revocation is unavailable here.
        Remove this application's access in Meta's account settings; provider
        access may remain until you do. This application has not verified remote
        revocation.
      </p>
    </aside>
  )
}
export function IntegrationError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? error.message
          : 'Unable to load integrations. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
