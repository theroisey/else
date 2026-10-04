import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Status, buttonStyles } from '../../components/ui'
import { formatTime } from '../../lib/time'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError } from '../integrations/Shared'
import { useAnalytics } from './hooks'
import { validPeriod } from './models'
import type { Period, View } from './models'
import { PeriodFields } from './PeriodFields'
import { DailyTrend, ReportTable } from './ReportTables'
import * as service from './service'

export function AnalyticsReportPage() {
  const { id = '', connectionID = '' } = useParams()
  const operation = useAnalytics(id)
  if (!isUUID(id) || !isUUID(connectionID)) return <h1>Analytics not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return <Reports key={JSON.stringify([...operation.key, connectionID])} operation={operation} connectionID={connectionID} />
}
function Reports({ operation, connectionID }: { operation: ReturnType<typeof useAnalytics>; connectionID: string }) {
  const [draft, setDraft] = useState<Period>({ since: '', until: '' })
  const [period, setPeriod] = useState<Period | null>(null)
  const query = useQuery({ queryKey: [...operation.key, 'report', connectionID, period], retry: false, staleTime: 0,
    enabled: period !== null,
    queryFn: ({ signal }) => operation.read(() => service.read(operation.clientID, connectionID, period!, signal)) })
  const busy = period !== null && query.isFetching
  return <section className="max-w-6xl">
    <header className="mb-5"><p className="eyebrow">Client workspace · Web analytics</p><h1 className="mt-2 text-2xl font-semibold">GA4 reports</h1><p className="mt-2 text-sm text-muted">Choose the property dates of a stored report. Reading reports does not start a provider synchronization.</p></header>
    <nav aria-label="Analytics navigation" className="mb-5 flex flex-wrap gap-2"><Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/analytics`}>GA4 connections</Link>{operation.permissions.integrations ? <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/integrations/${connectionID}`}>Connection setup and sync</Link> : null}</nav>
    <form className="grid max-w-xl gap-3 rounded-md border border-line bg-surface p-4" onSubmit={e => {
      e.preventDefault()
      if (validPeriod(draft)) {
        if (period?.since === draft.since && period.until === draft.until) void query.refetch()
        else setPeriod({ ...draft })
      }
    }}>
      <PeriodFields period={draft} onChange={setDraft} disabled={busy} />
      <Button type="submit" disabled={busy || !validPeriod(draft)}>Load stored reports</Button>
    </form>
    {!period ? <p role="status" className="mt-5 text-muted">Select a date range to load reports.</p> : busy || query.isPending ? <p role="status" className="py-8">Loading GA4 reports…</p> : query.isError ? <IntegrationError error={query.error} retry={() => void query.refetch()} /> : <MeasuredReports key={JSON.stringify([period, query.data.status.synced_at])} view={query.data} />}
  </section>
}
const reasonLabels = { provider_unavailable: 'The provider request failed or returned an incomplete report. Review setup before requesting another synchronization.', authorization_required: 'Access changed. An authorized integration manager must review the connection.', connection_changed: 'The credential or connection changed. Older work was canceled.', interrupted: 'The worker was interrupted repeatedly. An integration manager can request a new synchronization.' }
function MeasuredReports({ view }: { view: View }) {
  const { status, data } = view
  const stateLabels = { not_synced: 'Not synchronized', queued: 'Queued', running: 'Synchronizing', succeeded: 'Synchronized', failed: 'Synchronization failed' }
  return <>
    <aside className="mt-5 rounded-md border border-line bg-surface p-4" aria-label="Synchronization status">
      <Status tone={status.state === 'failed' || status.stale ? 'warning' : status.state === 'succeeded' ? 'success' : 'neutral'}>{stateLabels[status.state]}</Status>
      {status.reason ? <p className="mt-2 text-sm">{reasonLabels[status.reason]}</p> : null}
      <p className="mt-2 text-sm">Last successful synchronization: {status.synced_at ? <time dateTime={status.synced_at}>{formatTime(status.synced_at, 'Europe/Istanbul')} (Europe/Istanbul)</time> : 'Never'}</p>
      {status.stale && data ? <p className="mt-2 text-sm">These reports are stale. They show the last successful observations and may differ from current provider data.</p> : null}
      {(status.state === 'queued' || status.state === 'running') ? <p className="mt-2 text-sm">Background work is pending. Load stored reports again to check progress.</p> : null}
    </aside>
    {!data ? <p role="status" className="mt-5 rounded-md border border-line p-5">No measured reports are available for this period. A manager can queue this date range from connection setup.</p> : <>
      <p className="mt-5 text-sm text-muted">Property timezone: <strong>{data.summary.timezone}</strong> · {data.summary.since} through {data.summary.until}, inclusive.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{data.definitions.map((definition, i) => <section className="rounded-md border border-line bg-surface p-4" key={definition.name}>
        <h2 className="text-sm font-semibold">{definition.display_name}</h2><p className="mt-2 break-all text-2xl font-semibold tabular-nums">{data.summary.rows[0]?.metrics[i] ?? 'No observations'}</p><p className="mt-2 text-xs leading-5 text-muted">{definition.description}</p>
      </section>)}</div>
      <p className="mt-3 text-xs text-muted">Period totals come from GA4's independent summary. Daily users are not added together. Key events retain GA4's reported attribution fractions.</p>
      <DailyTrend report={data.daily} />
      <ReportTable title="Daily trends" report={data.daily} definitions={data.definitions} />
      <ReportTable title="Traffic acquisition" report={data.acquisition} definitions={data.definitions} />
      <ReportTable title="Devices" report={data.devices} definitions={data.definitions} />
      <ReportTable title="Landing pages" report={data.landing} definitions={data.definitions} />
    </>}
  </>
}
