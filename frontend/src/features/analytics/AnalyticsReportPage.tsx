import { formatCalendarDate, formatDecimal } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { websiteBase } from '../websites/service'
import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Status, buttonStyles, PageSkeleton } from '../../components/ui'
import { formatTime } from '../../lib/time'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError } from '../integrations/Shared'
import { useAnalytics } from './hooks'
import { metricCopy } from './metric-copy'
import { validPeriod } from './models'
import type { Period, View } from './models'
import { PeriodFields } from './PeriodFields'
import { DailyTrend, ReportTable } from './ReportTables'
import * as service from './service'

export function AnalyticsReportPage() {
  useLocale()
  const { id = '', connectionID = '' } = useParams()
  const operation = useAnalytics(id)
  if (!isUUID(id) || !isUUID(connectionID))
    return (
      <h1 className="page-title">{copy('Analytics not found', 'analytics')}</h1>
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
  operation: ReturnType<typeof useAnalytics>
  connectionID: string
}) {
  useLocale()
  const { websiteID } = useParams()
  const [draft, setDraft] = useState<Period>({ since: '', until: '' })
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
            {copy('Client workspace · Web analytics', 'analytics')}
          </p>
          <h1 className="page-title">{copy('GA4 reports', 'analytics')}</h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'Choose the property dates of a stored report. Reading reports does not start a provider synchronization.',
              'analytics',
            )}
          </p>
        </div>
      </header>
      <ClientNavigation clientID={operation.clientID} />
      <nav
        aria-label={copy('Analytics navigation', 'analytics')}
        className="mb-5 flex flex-wrap gap-2"
      >
        <Link
          className={buttonStyles()}
          to={`${websiteBase(operation.clientID, websiteID)}/analytics`}
        >
          {copy('GA4 connections', 'analytics')}
        </Link>
        {operation.permissions.integrations ? (
          <Link
            className={buttonStyles()}
            to={`${websiteBase(operation.clientID, websiteID)}/integrations/${connectionID}`}
          >
            {copy('Connection setup and sync', 'analytics')}
          </Link>
        ) : null}
      </nav>
      <form
        className="grid max-w-xl gap-3 form-section"
        onSubmit={(e) => {
          e.preventDefault()
          if (validPeriod(draft)) {
            if (period?.since === draft.since && period.until === draft.until)
              void query.refetch()
            else setPeriod({ ...draft })
          }
        }}
      >
        <PeriodFields period={draft} onChange={setDraft} disabled={busy} />
        <Button type="submit" disabled={busy || !validPeriod(draft)}>
          {copy('Load stored reports', 'analytics')}
        </Button>
      </form>
      {!period ? (
        <p role="status" className="mt-5 text-muted">
          {copy('Select a date range to load reports.', 'analytics')}
        </p>
      ) : busy || query.isPending ? (
        <PageSkeleton label={copy('Loading GA4 reports…', 'analytics')} />
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
const reasonLabels = {
  provider_unavailable:
    'The provider request failed or returned an incomplete report. Review setup before requesting another synchronization.',
  authorization_required:
    'Access changed. An authorized integration manager must review the connection.',
  connection_changed:
    'The credential or connection changed. Older work was canceled.',
  interrupted:
    'The worker was interrupted repeatedly. An integration manager can request a new synchronization.',
}
function MeasuredReports({ view }: { view: View }) {
  useLocale()
  const { status, data } = view
  const stateLabels = {
    not_synced: copy('Not synchronized', 'analytics'),
    queued: copy('Queued', 'analytics'),
    running: copy('Synchronizing', 'analytics'),
    succeeded: copy('Synchronized', 'analytics'),
    failed: copy('Synchronization failed', 'analytics'),
  }
  return (
    <>
      <aside
        className="mt-5 border-l-2 border-line-strong pl-4 py-2"
        aria-label={copy('Synchronization status', 'analytics')}
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
          {copy(stateLabels[status.state], 'analytics')}
        </Status>
        {status.reason ? (
          <p className="mt-2 text-sm">
            {copy(reasonLabels[status.reason], 'analytics')}
          </p>
        ) : null}
        <p className="mt-2 text-sm">
          {copy('Last successful synchronization:', 'analytics')}{' '}
          {status.synced_at ? (
            <time dateTime={status.synced_at}>
              {formatTime(status.synced_at, 'Europe/Istanbul')}{' '}
              (Europe/Istanbul)
            </time>
          ) : (
            copy('Never', 'analytics')
          )}
        </p>
        {status.stale && data ? (
          <p className="mt-2 text-sm">
            {copy(
              'These reports are stale. They show the last successful observations and may differ from current provider data.',
              'analytics',
            )}
          </p>
        ) : null}
        {status.state === 'queued' || status.state === 'running' ? (
          <p className="mt-2 text-sm">
            {copy(
              'Background work is pending. Load stored reports again to check progress.',
              'analytics',
            )}
          </p>
        ) : null}
      </aside>
      {!data ? (
        <p role="status" className="mt-5 rounded-md border border-line p-5">
          {copy(
            'No measured reports are available for this period. A manager can queue this date range from connection setup.',
            'analytics',
          )}
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm text-muted">
            {copy('Property timezone:', 'analytics')}{' '}
            <strong>{data.summary.timezone}</strong> ·{' '}
            {copy('{{value1}} through {{value2}}', 'analytics', {
              value1: formatCalendarDate(data.summary.since),
              value2: formatCalendarDate(data.summary.until),
            })}
            {copy(', inclusive.', 'analytics')}
          </p>
          <div className="metric-strip">
            {data.definitions.map((definition, i) => (
              <section className="metric-cell" key={definition.name}>
                <h2 className="text-sm font-semibold">
                  {metricCopy(definition.name).label}
                </h2>
                <p className="mt-2 break-all text-2xl font-semibold tabular-nums">
                  {data.summary.rows[0]?.metrics[i] === undefined
                    ? copy('No observations', 'analytics')
                    : formatDecimal(data.summary.rows[0].metrics[i]!)}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted">
                  {metricCopy(definition.name).description}
                </p>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            {copy(
              "Period totals come from GA4's independent summary. Daily users are not added together. Key events retain GA4's reported attribution fractions.",
              'analytics',
            )}
          </p>
          <DailyTrend report={data.daily} />
          <ReportTable
            title={copy('Daily trends', 'analytics')}
            report={data.daily}
            definitions={data.definitions}
          />
          <ReportTable
            title={copy('Traffic acquisition', 'analytics')}
            report={data.acquisition}
            definitions={data.definitions}
          />
          <ReportTable
            title={copy('Devices', 'analytics')}
            report={data.devices}
            definitions={data.definitions}
          />
          <ReportTable
            title={copy('Landing pages', 'analytics')}
            report={data.landing}
            definitions={data.definitions}
          />
        </>
      )}
    </>
  )
}
