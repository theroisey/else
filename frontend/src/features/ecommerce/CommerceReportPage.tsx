import { formatCalendarDate } from '../../i18n/format'
import { formatTime } from '../../lib/time'
import { copy, useLocale } from '../../i18n/index'
import { websiteBase } from '../websites/service'
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
  useLocale()
  const { id = '', connectionID = '' } = useParams()
  const operation = useCommerce(id)
  if (!isUUID(id) || !isUUID(connectionID))
    return (
      <h1 className="page-title">{copy('Commerce not found', 'commerce')}</h1>
    )
  if (!operation.permissions.view) return <AccessDenied />
  return (
    <Reports
      key={JSON.stringify([...operation.key, connectionID])}
      operation={operation}
      connectionID={connectionID}
    />
  )
}
function Reports({
  operation,
  connectionID,
}: {
  operation: ReturnType<typeof useCommerce>
  connectionID: string
}) {
  useLocale()
  const { websiteID } = useParams()
  const [draft, setDraft] = useState<Period>({
    start: '',
    end: '',
    currency: 'USD',
  })
  const [period, setPeriod] = useState<Period | null>(null)
  const query = useQuery({
    queryKey: [...operation.key, 'report', websiteID, connectionID, period],
    retry: false,
    staleTime: 0,
    enabled: period !== null,
    queryFn: ({ signal }) =>
      operation.read(() =>
        service.read(
          operation.clientID,
          connectionID,
          period!,
          signal,
          websiteID,
        ),
      ),
  })
  const busy = period !== null && query.isFetching
  return (
    <section className="max-w-6xl">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            {copy('Client workspace · Commerce', 'commerce')}
          </p>
          <h1 className="page-title">
            {copy('WooCommerce reports', 'commerce')}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'Choose the explicit UTC period and currency of a stored report. Reading reports does not start a store synchronization.',
              'commerce',
            )}
          </p>
        </div>
      </header>
      <ClientNavigation clientID={operation.clientID} />
      <nav
        aria-label={copy('Commerce navigation', 'commerce')}
        className="mb-5 flex flex-wrap gap-2"
      >
        <Link
          className={buttonStyles()}
          to={`${websiteBase(operation.clientID, websiteID)}/commerce`}
        >
          {copy('Store connections', 'commerce')}
        </Link>
        {operation.permissions.integrations ? (
          <Link
            className={buttonStyles()}
            to={`${websiteBase(operation.clientID, websiteID)}/integrations/${connectionID}`}
          >
            {copy('Connection setup and sync', 'commerce')}
          </Link>
        ) : null}
      </nav>
      <form
        className="grid max-w-xl gap-3 form-section"
        onSubmit={(e) => {
          e.preventDefault()
          if (validPeriod(draft)) {
            if (
              period?.start === draft.start &&
              period.end === draft.end &&
              period.currency === draft.currency
            )
              void query.refetch()
            else setPeriod({ ...draft })
          }
        }}
      >
        <PeriodFields period={draft} onChange={setDraft} disabled={busy} />
        <Button type="submit" disabled={busy || !validPeriod(draft)}>
          {copy('Load stored reports', 'commerce')}
        </Button>
      </form>
      {!period ? (
        <p role="status" className="mt-5 text-muted">
          {copy(
            'Select a UTC period and currency to load reports.',
            'commerce',
          )}
        </p>
      ) : busy || query.isPending ? (
        <PageSkeleton
          label={copy('Loading WooCommerce reports…', 'commerce')}
        />
      ) : query.isError ? (
        <IntegrationError
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : (
        <MeasuredReports
          key={JSON.stringify([period, query.data.status.synced_at])}
          view={query.data}
        />
      )}
    </section>
  )
}
function MeasuredReports({ view }: { view: View }) {
  useLocale()
  const { status, data } = view
  return (
    <>
      <ReportStatus status={status} hasData={!!data} />
      {!data ? (
        <p role="status" className="mt-5 rounded-md border border-line p-5">
          {copy(
            'No measured reports are available for this UTC period and currency. A manager can queue this selection from connection setup.',
            'commerce',
          )}
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm text-muted">
            {copy('Currency:', 'commerce')}{' '}
            <strong>{data.orders.currency}</strong>{' '}
            {copy('· UTC period:', 'commerce')}{' '}
            <time dateTime={data.orders.start}>
              {formatCalendarDate(data.orders.start)}
            </time>{' '}
            {copy('to', 'commerce')}{' '}
            <time dateTime={data.orders.end}>
              {formatCalendarDate(data.orders.end)}
            </time>{' '}
            {copy('(end exclusive).', 'commerce')}
          </p>
          <p className="mt-2 break-words text-xs text-muted">
            {copy('Collection interval (UTC):', 'commerce')}{' '}
            <time dateTime={data.collected_from}>
              {formatTime(data.collected_from, 'UTC')}
            </time>{' '}
            {copy('to', 'commerce')}{' '}
            <time dateTime={data.collected_through}>
              {formatTime(data.collected_through, 'UTC')}
            </time>
            {copy(
              '. This is a bounded collection, not a transactional store snapshot.',
              'commerce',
            )}
          </p>
          <div className="metric-strip">
            {[
              [
                copy('Order-created grand total', 'commerce'),
                data.orders.grand_total_minor,
              ],
              [
                copy('Lifetime refunded in order cohort', 'commerce'),
                data.orders.lifetime_refund_minor,
              ],
              [
                copy('Remaining grand in order cohort', 'commerce'),
                data.orders.remainder_minor,
              ],
              [
                copy('Refund-created amounts in period', 'commerce'),
                data.refunds.amount_minor,
              ],
            ].map(([label, value]) => (
              <section className="metric-cell" key={label}>
                <h2 className="text-sm font-semibold">{label}</h2>
                <p className="mt-2 break-all text-xl font-semibold tabular-nums">
                  {money(value!, data.orders.currency)}
                </p>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {copy(
              'All reported order statuses are included. Grand and remaining amounts do not prove payment or recognized revenue. Refund-created events describe a different cohort and are never subtracted to invent net revenue.',
              'commerce',
            )}
          </p>
          <DailyTrend data={data} />
          <CommerceTables data={data} />
        </>
      )}
    </>
  )
}
