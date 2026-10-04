import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError } from '../integrations/Shared'
import { useMarketing } from './hooks'
import { amount, validPeriod } from './models'
import type { Period, View } from './models'
import { PeriodFields } from '../analytics/PeriodFields'
import { MetaTables, DailySpend } from './ReportTables'
import { ReportStatus } from '../integrations/ReportStatus'
import * as service from './service'

export function MarketingReportPage() {
  const { id = '', connectionID = '' } = useParams()
  const operation = useMarketing(id)
  if (!isUUID(id) || !isUUID(connectionID)) return <h1>Marketing not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return <Reports key={JSON.stringify([...operation.key, connectionID])} operation={operation} connectionID={connectionID} />
}
function Reports({ operation, connectionID }: { operation: ReturnType<typeof useMarketing>; connectionID: string }) {
  const [draft, setDraft] = useState<Period>({ since: '', until: '' })
  const [period, setPeriod] = useState<Period | null>(null)
  const query = useQuery({ queryKey: [...operation.key, 'report', connectionID, period], retry: false, staleTime: 0,
    enabled: period !== null,
    queryFn: ({ signal }) => operation.read(() => service.read(operation.clientID, connectionID, period!, signal)) })
  const busy = period !== null && query.isFetching
  return <section className="max-w-6xl">
    <header className="mb-5"><p className="eyebrow">Client workspace · Marketing</p><h1 className="mt-2 text-2xl font-semibold">Meta Ads reports</h1><p className="mt-2 text-sm text-muted">Choose the ad-account dates of a stored report. Reading reports does not start a provider synchronization.</p></header>
    <nav aria-label="Analytics navigation" className="mb-5 flex flex-wrap gap-2"><Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/marketing`}>Meta connections</Link>{operation.permissions.integrations ? <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/integrations/${connectionID}`}>Connection setup and sync</Link> : null}</nav>
    <form className="grid max-w-xl gap-3 rounded-md border border-line bg-surface p-4" onSubmit={e => {
      e.preventDefault()
      if (validPeriod(draft)) {
        if (period?.since === draft.since && period.until === draft.until) void query.refetch()
        else setPeriod({ ...draft })
      }
    }}>
      <PeriodFields calendar="Meta ad-account" period={draft} onChange={setDraft} disabled={busy} />
      <Button type="submit" disabled={busy || !validPeriod(draft)}>Load stored reports</Button>
    </form>
    {!period ? <p role="status" className="mt-5 text-muted">Select a date range to load reports.</p> : busy || query.isPending ? <p role="status" className="py-8">Loading Meta Ads reports…</p> : query.isError ? <IntegrationError error={query.error} retry={() => void query.refetch()} /> : <MeasuredReports key={JSON.stringify([period, query.data.status.synced_at])} view={query.data} />}
  </section>
}
function MeasuredReports({ view }: { view: View }) {
  const { status, data } = view
  const report = data?.report
  const totals = report?.totals
  const observed = !!report?.days.length
  return <>
    <ReportStatus status={status} hasData={!!data} />
    {!data || !report || !totals ? <p role="status" className="mt-5 rounded-md border border-line p-5">No measured reports are available for this period. A manager can queue this date range from connection setup.</p> : <>
      <p className="mt-5 text-sm text-muted">Ad-account timezone: <strong>{report.timezone}</strong> · {report.since} through {report.until}, inclusive · Currency: {report.currency}</p>
      <p className="mt-2 text-xs text-muted">Collection interval: {data.collected_from} through {data.collected_through} (UTC). First-page and account checks detect observed changes; this interval is not a transactional provider snapshot.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[
        ['Reported spend', amount(totals.spend_decimal, report.currency)], ['Impressions', totals.impressions], ['Clicks', totals.clicks],
        ['CTR', totals.ctr_percent === null ? 'Unavailable' : totals.ctr_percent + '%'],
        ['CPC', totals.cpc_decimal === null ? 'Unavailable' : amount(totals.cpc_decimal, report.currency)],
        ['CPM', totals.cpm_decimal === null ? 'Unavailable' : amount(totals.cpm_decimal, report.currency)],
      ].map(([label, value]) => <section className="min-w-0 rounded-md border border-line bg-surface p-4" key={label}>
        <h2 className="text-sm font-semibold">{label}</h2><p className="mt-2 break-all text-2xl font-semibold tabular-nums">{observed ? value : 'No observations'}</p>
      </section>)}</div>
      <p className="mt-3 text-xs leading-5 text-muted">Spend retains the provider's exact decimal in the account currency; no currency conversion or guessed minor-unit rounding. CTR = clicks ÷ impressions × 100, CPC = spend ÷ clicks, CPM = spend ÷ impressions × 1,000. Period ratios use summed observations, rounded half up to six decimal places. Zero denominators are unavailable.</p>
      <DailySpend data={data} />
      <MetaTables data={data} />
      <p className="mt-3 text-sm text-muted">Conversion attribution, revenue and ROAS are unavailable in this report. Missing dates are not filled with zero. Clicks do not imply site sessions or purchases.</p>
    </>}
  </>
}
