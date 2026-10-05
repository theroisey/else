import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  return (
    <>
      <PageHeader
        eyebrow={copy('{{client}} · Integrations', 'integrations', {
          client: name ?? copy('Client workspace', 'common'),
        })}
        title={
          detail
            ? copy('Integration connection', 'integrations')
            : copy('Integrations', 'integrations')
        }
        description={copy(
          'Recorded connection metadata. These states do not verify current provider access or synchronization. Times use Europe/Istanbul.',
          'integrations',
        )}
      />
      <ClientNavigation clientID={clientID} />
    </>
  )
}
export function IntegrationState({ record }: { record: Connection }) {
  useLocale()
  const attention = ['revocation_failed', 'reauthorization_required'].includes(
    record.state,
  )
  return (
    <Status tone={attention ? 'warning' : 'neutral'}>
      {copy(labels[record.state], 'integrations')}
    </Status>
  )
}
export function ManualAction({
  provider,
}: {
  provider: Connection['provider']
}) {
  useLocale()
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
        {copy('Remote revocation requires manual action', 'integrations')}{' '}
      </h2>
      <p className="mt-2 text-sm leading-6">
        {copy(
          "Local credential use is disabled. Remote revocation is unavailable here. Remove this application's access in the {{value1}} account settings; provider access may remain until you do. This application has not verified remote revocation.",
          'integrations',
          { value1: providerLabels[provider] },
        )}
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
  useLocale()
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? copy(error.message, 'integrations')
          : copy('Unable to load integrations. Try again.', 'integrations')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'integrations')}
      </Button>
    </div>
  )
}
