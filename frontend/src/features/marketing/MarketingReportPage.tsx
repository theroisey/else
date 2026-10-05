import {
  formatCalendarDate,
  formatNumber,
  formatPercent,
} from '../../i18n/format'
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
import { useMarketing } from './hooks'
import { amount, validPeriod } from './models'
import type { Period, View } from './models'
import { PeriodFields } from '../analytics/PeriodFields'
import { MetaTables, DailySpend } from './ReportTables'
import { ReportStatus } from '../integrations/ReportStatus'
import * as service from './service'

export function MarketingReportPage() {
  useLocale()
  const { id = '', connectionID = '' } = useParams()
  const operation = useMarketing(id)
  if (!isUUID(id) || !isUUID(connectionID))
    return (
      <h1 className="page-title">{copy('Marketing not found', 'marketing')}</h1>
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
  operation: ReturnType<typeof useMarketing>
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
            {copy('Client workspace · Marketing', 'marketing')}
          </p>
          <h1 className="page-title">
            {copy('Meta Ads reports', 'marketing')}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'Choose the ad-account dates of a stored report. Reading reports does not start a provider synchronization.',
              'marketing',
            )}
          </p>
        </div>
      </header>
      <ClientNavigation clientID={operation.clientID} />
      <nav
        aria-label={copy('Analytics navigation', 'marketing')}
        className="mb-5 flex flex-wrap gap-2"
      >
        <Link
          className={buttonStyles()}
          to={`${websiteBase(operation.clientID, websiteID)}/marketing`}
        >
          {copy('Meta connections', 'marketing')}
        </Link>
        {operation.permissions.integrations ? (
          <Link
            className={buttonStyles()}
            to={`${websiteBase(operation.clientID, websiteID)}/integrations/${connectionID}`}
          >
            {copy('Connection setup and sync', 'marketing')}
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
        <PeriodFields
          calendar={copy('Meta ad-account', 'marketing')}
          period={draft}
          onChange={setDraft}
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !validPeriod(draft)}>
          {copy('Load stored reports', 'marketing')}
        </Button>
      </form>
      {!period ? (
        <p role="status" className="mt-5 text-muted">
          {copy('Select a date range to load reports.', 'marketing')}
        </p>
      ) : busy || query.isPending ? (
        <PageSkeleton label={copy('Loading Meta Ads reports…', 'marketing')} />
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
  const report = data?.report
  const totals = report?.totals
  const observed = !!report?.days.length
  return (
    <>
      <ReportStatus status={status} hasData={!!data} />
      {!data || !report || !totals ? (
        <p role="status" className="mt-5 rounded-md border border-line p-5">
          {copy(
            'No measured reports are available for this period. A manager can queue this date range from connection setup.',
            'marketing',
          )}
        </p>
      ) : (
        <>
          <p className="mt-5 text-sm text-muted">
            {copy('Ad-account timezone:', 'marketing')}{' '}
            <strong>{report.timezone}</strong> ·{' '}
            {copy('{{value1}} through {{value2}}', 'marketing', {
              value1: formatCalendarDate(report.since),
              value2: formatCalendarDate(report.until),
            })}
            {copy(', inclusive · Currency:', 'marketing')} {report.currency}
          </p>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Collection interval: {{value1}} through {{value2}} (UTC). First-page and account checks detect observed changes; this interval is not a transactional provider snapshot.',
              'marketing',
              {
                value1: formatTime(data.collected_from, 'UTC'),
                value2: formatTime(data.collected_through, 'UTC'),
              },
            )}
          </p>
          <div className="metric-strip">
            {[
              [
                copy('Reported spend', 'marketing'),
                amount(totals.spend_decimal, report.currency),
              ],
              [
                copy('Impressions', 'marketing'),
                formatNumber(totals.impressions),
              ],
              [copy('Clicks', 'marketing'), formatNumber(totals.clicks)],
              [
                'CTR',
                totals.ctr_percent === null
                  ? copy('Unavailable', 'marketing')
                  : formatPercent(totals.ctr_percent),
              ],
              [
                'CPC',
                totals.cpc_decimal === null
                  ? copy('Unavailable', 'marketing')
                  : amount(totals.cpc_decimal, report.currency),
              ],
              [
                'CPM',
                totals.cpm_decimal === null
                  ? copy('Unavailable', 'marketing')
                  : amount(totals.cpm_decimal, report.currency),
              ],
            ].map(([label, value]) => (
              <section className="metric-cell" key={label}>
                <h2 className="text-sm font-semibold">{label}</h2>
                <p className="mt-2 break-all text-2xl font-semibold tabular-nums">
                  {observed ? value : copy('No observations', 'marketing')}
                </p>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            {copy(
              "Spend retains the provider's exact decimal in the account currency; no currency conversion or guessed minor-unit rounding. CTR = clicks ÷ impressions × 100, CPC = spend ÷ clicks, CPM = spend ÷ impressions × 1,000. Period ratios use summed observations, rounded half up to six decimal places. Zero denominators are unavailable.",
              'marketing',
            )}
          </p>
          <DailySpend data={data} />
          <MetaTables data={data} />
          <p className="mt-3 text-sm text-muted">
            {copy(
              'Conversion attribution, revenue and ROAS are unavailable in this report. Missing dates are not filled with zero. Clicks do not imply site sessions or purchases.',
              'marketing',
            )}
          </p>
        </>
      )}
    </>
  )
}
