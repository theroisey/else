import { ClientNavigation } from '../clients/ClientNavigation'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, PageHeader } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { labels, providerLabels } from './models'
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
      <PageHeader
        eyebrow={`${name ?? 'Client workspace'} · Integrations`}
        title={detail ? 'Integration connection' : 'Integrations'}
        description="Recorded connection metadata. These states do not verify current provider access or synchronization. Times use Europe/Istanbul."
      />
      <ClientNavigation clientID={clientID} />
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
export function ManualAction({ provider }: { provider: Connection['provider'] }) {
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
        Remove this application's access in the {providerLabels[provider]} account
        settings; provider access may remain until you do. This application has not verified remote
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
