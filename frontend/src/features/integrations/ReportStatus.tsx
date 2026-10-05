import { copy, useLocale } from '../../i18n/index'
import { Status } from '../../components/ui'
import { formatTime } from '../../lib/time'
import type { z } from '../../lib/validation'
import type { syncStatus } from './report-contracts'

const reasons = {
  provider_unavailable:
    'The provider request failed or returned an incomplete report. Review setup before requesting another synchronization.',
  authorization_required:
    'Access changed. An authorized integration manager must review the connection.',
  connection_changed:
    'The credential or connection changed. Older work was canceled.',
  interrupted:
    'The worker was interrupted repeatedly. An integration manager can request a new synchronization.',
}
const states = {
  not_synced: 'Not synchronized',
  queued: 'Queued',
  running: 'Synchronizing',
  succeeded: 'Synchronized',
  failed: 'Synchronization failed',
}
export function ReportStatus({
  status,
  hasData,
}: {
  status: z.infer<typeof syncStatus>
  hasData: boolean
}) {
  useLocale()
  return (
    <aside
      className="mt-5 form-section"
      aria-label={copy('Synchronization status', 'integrations')}
    >
      <Status
        tone={
          status.state === 'failed' || status.stale
            ? 'warning'
            : status.state === 'succeeded'
              ? 'success'
              : 'neutral'
        }
      >
        {states[status.state]}
      </Status>
      {status.reason ? (
        <p className="mt-2 text-sm">{reasons[status.reason]}</p>
      ) : null}
      <p className="mt-2 text-sm">
        {copy('Last successful synchronization:', 'integrations')}{' '}
        {status.synced_at ? (
          <time dateTime={status.synced_at}>
            {formatTime(status.synced_at, 'Europe/Istanbul')} (Europe/Istanbul)
          </time>
        ) : (
          copy('Never', 'integrations')
        )}
      </p>
      {status.stale && hasData ? (
        <p className="mt-2 text-sm">
          {copy(
            'These reports are stale. They show the last successful observations and may differ from current provider data.',
            'integrations',
          )}
        </p>
      ) : null}
      {status.state === 'queued' || status.state === 'running' ? (
        <p className="mt-2 text-sm">
          {copy(
            'Background work is pending. Load stored reports again to check progress.',
            'integrations',
          )}
        </p>
      ) : null}
    </aside>
  )
}
