import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles, PageSkeleton } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError } from '../integrations/Shared'
import { ReportStatus } from '../integrations/ReportStatus'
import { useCommerce } from './hooks'
import { money, validPeriod } from './models'
import type { Period, View } from './models'
import { PeriodFields } from './PeriodFields'
import { CommerceTables, DailyTrend } from './ReportTables'
import * as service from './service'

export function CommerceReportPage() {
  const { id = '', connectionID = '' } = useParams()
  const operation = useCommerce(id)
  if (!isUUID(id) || !isUUID(connectionID)) return <h1 className="page-title">Commerce not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return <Reports key={JSON.stringify([...operation.key, connectionID])} operation={operation} connectionID={connectionID} />
}
function Reports({ operation, connectionID }: { operation: ReturnType<typeof useCommerce>; connectionID: string }) {
  const [draft, setDraft] = useState<Period>({ start: '', end: '', currency: 'USD' })
  const [period, setPeriod] = useState<Period | null>(null)
  const query = useQuery({ queryKey: [...operation.key, 'report', connectionID, period], retry: false, staleTime: 0,
    enabled: period !== null,
    queryFn: ({ signal }) => operation.read(() => service.read(operation.clientID, connectionID, period!, signal)) })
  const busy = period !== null && query.isFetching
  return <section className="max-w-6xl">
    <header className="page-header"><div><p className="eyebrow">Client workspace · Commerce</p><h1 className="page-title">WooCommerce reports</h1><p className="mt-2 text-sm text-muted">Choose the explicit UTC period and currency of a stored report. Reading reports does not start a store synchronization.</p></div></header>
    <ClientNavigation clientID={operation.clientID} /><nav aria-label="Commerce navigation" className="mb-5 flex flex-wrap gap-2"><Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/commerce`}>Store connections</Link>{operation.permissions.integrations ? <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/integrations/${connectionID}`}>Connection setup and sync</Link> : null}</nav>
    <form className="grid max-w-xl gap-3 form-section" onSubmit={e => {
      e.preventDefault()
      if (validPeriod(draft)) {
        if (period?.start === draft.start && period.end === draft.end && period.currency === draft.currency) void query.refetch()
        else setPeriod({ ...draft })
      }
    }}>
      <PeriodFields period={draft} onChange={setDraft} disabled={busy} />
      <Button type="submit" disabled={busy || !validPeriod(draft)}>Load stored reports</Button>
    </form>
    {!period ? <p role="status" className="mt-5 text-muted">Select a UTC period and currency to load reports.</p> : busy || query.isPending ? <PageSkeleton label="Loading WooCommerce reports…" /> : query.isError ? <IntegrationError error={query.error} retry={() => void query.refetch()} /> : <MeasuredReports key={JSON.stringify([period, query.data.status.synced_at])} view={query.data} />}
  </section>
}
function MeasuredReports({ view }: { view: View }) {
  const { status, data } = view
  return <>
    <ReportStatus status={status} hasData={!!data} />
    {!data ? <p role="status" className="mt-5 rounded-md border border-line p-5">No measured reports are available for this UTC period and currency. A manager can queue this selection from connection setup.</p> : <>
      <p className="mt-5 text-sm text-muted">Currency: <strong>{data.orders.currency}</strong> · UTC period: <time dateTime={data.orders.start}>{data.orders.start}</time> to <time dateTime={data.orders.end}>{data.orders.end}</time> (end exclusive).</p>
      <p className="mt-2 break-words text-xs text-muted">Collection interval (UTC): <time dateTime={data.collected_from}>{data.collected_from}</time> to <time dateTime={data.collected_through}>{data.collected_through}</time>. This is a bounded collection, not a transactional store snapshot.</p>
      <div className="metric-strip">{[
        ['Order-created grand total', data.orders.grand_total_minor], ['Lifetime refunded in order cohort', data.orders.lifetime_refund_minor],
        ['Remaining grand in order cohort', data.orders.remainder_minor], ['Refund-created amounts in period', data.refunds.amount_minor],
      ].map(([label, value]) => <section className="metric-cell" key={label}><h2 className="text-sm font-semibold">{label}</h2><p className="mt-2 break-all text-xl font-semibold tabular-nums">{money(value!, data.orders.currency)}</p></section>)}</div>
      <p className="mt-3 text-xs text-muted">All reported order statuses are included. Grand and remaining amounts do not prove payment or recognized revenue. Refund-created events describe a different cohort and are never subtracted to invent net revenue.</p>
      <DailyTrend data={data} />
      <CommerceTables data={data} />
    </>}
  </>
}
