import { Status } from '../../components/ui'
import { formatTime } from '../../lib/time'
import type { z } from '../../lib/validation'
import type { syncStatus } from './report-contracts'

const reasons = {
  provider_unavailable: 'The provider request failed or returned an incomplete report. Review setup before requesting another synchronization.',
  authorization_required: 'Access changed. An authorized integration manager must review the connection.',
  connection_changed: 'The credential or connection changed. Older work was canceled.',
  interrupted: 'The worker was interrupted repeatedly. An integration manager can request a new synchronization.',
}
const states = { not_synced: 'Not synchronized', queued: 'Queued', running: 'Synchronizing', succeeded: 'Synchronized', failed: 'Synchronization failed' }
export function ReportStatus({ status, hasData }: { status: z.infer<typeof syncStatus>; hasData: boolean }) {
  return <aside className="mt-5 rounded-md border border-line bg-surface p-4" aria-label="Synchronization status">
    <Status tone={status.state === 'failed' || status.stale ? 'warning' : status.state === 'succeeded' ? 'success' : 'neutral'}>{states[status.state]}</Status>
    {status.reason ? <p className="mt-2 text-sm">{reasons[status.reason]}</p> : null}
    <p className="mt-2 text-sm">Last successful synchronization: {status.synced_at ? <time dateTime={status.synced_at}>{formatTime(status.synced_at, 'Europe/Istanbul')} (Europe/Istanbul)</time> : 'Never'}</p>
    {status.stale && hasData ? <p className="mt-2 text-sm">These reports are stale. They show the last successful observations and may differ from current provider data.</p> : null}
    {status.state === 'queued' || status.state === 'running' ? <p className="mt-2 text-sm">Background work is pending. Load stored reports again to check progress.</p> : null}
  </aside>
}
