import {
  formatCalendarDate,
  formatNumber,
  formatPercent,
} from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Button, Table } from '../../components/ui'
import { amount, spendUnits } from './models'
import type { Workspace } from './models'

export function MetaTables({ data }: { data: Workspace }) {
  useLocale()
  const [page, setPage] = useState(0)
  const r = data.report,
    visible = r.days.slice(page * 25, (page + 1) * 25)
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-lg font-semibold">
        {copy('Daily account observations', 'marketing')}
      </h2>
      {!r.days.length ? (
        <p
          role="status"
          className="rounded-md border border-line p-4 text-muted"
        >
          {copy(
            'No daily observations were reported for this period.',
            'marketing',
          )}
        </p>
      ) : (
        <>
          <Table caption={copy('Daily account observations', 'marketing')}>
            <thead>
              <tr>
                {[
                  copy('Account date', 'marketing'),
                  copy('Spend', 'marketing'),
                  copy('Impressions', 'marketing'),
                  copy('Clicks', 'marketing'),
                  'CTR',
                  'CPC',
                  'CPM',
                ].map((label, index) => (
                  <th className={index === 0 ? '' : 'text-right'} key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((day) => (
                <tr key={day.date}>
                  {[
                    formatCalendarDate(day.date),
                    amount(day.spend_decimal, r.currency),
                    formatNumber(day.impressions),
                    formatNumber(day.clicks),
                    day.ctr_percent === null
                      ? copy('Unavailable', 'marketing')
                      : formatPercent(day.ctr_percent),
                    day.cpc_decimal === null
                      ? copy('Unavailable', 'marketing')
                      : amount(day.cpc_decimal, r.currency),
                    day.cpm_decimal === null
                      ? copy('Unavailable', 'marketing')
                      : amount(day.cpm_decimal, r.currency),
                  ].map((cell, i) => (
                    <td
                      className={`whitespace-nowrap tabular-nums ${i ? 'text-right' : ''}`}
                      key={i}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
          <div
            className="mt-3 flex flex-wrap items-center gap-3"
            aria-label={copy('Daily account observation pages', 'marketing')}
          >
            <Button
              size="compact"
              disabled={page === 0}
              onClick={() => setPage((v) => v - 1)}
            >
              {copy('Previous observations', 'marketing')}
            </Button>
            <span className="text-xs text-muted">
              {copy('Rows {{value1}}–{{value2}} of {{value3}}', 'marketing', {
                value1: page * 25 + 1,
                value2: page * 25 + visible.length,
                value3: r.days.length,
              })}
            </span>
            <Button
              size="compact"
              disabled={(page + 1) * 25 >= r.days.length}
              onClick={() => setPage((v) => v + 1)}
            >
              {copy('Next observations', 'marketing')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
export function DailySpend({ data }: { data: Workspace }) {
  useLocale()
  const r = data.report
  if (!r.days.length) return null
  const maximum = r.days.reduce((max, day) => {
    const value = spendUnits(day.spend_decimal)
    return value > max ? value : max
  }, 0n)
  const width = 620 / r.days.length
  const barWidth = Math.max(1, Math.min(24, width * 0.6))
  return (
    <figure className="chart-panel" tabIndex={0}>
      <figcaption className="font-semibold">
        {copy('Daily observed spend · {{value1}}', 'marketing', {
          value1: r.currency,
        })}
      </figcaption>
      <p className="mt-1 text-xs text-muted">
        {copy(
          'Only observed ad-account dates are shown. Missing days remain unmeasured.',
          'marketing',
        )}
      </p>
      <svg
        viewBox="0 0 640 190"
        role="img"
        aria-label={copy('Daily observed Meta spend', 'marketing')}
        className="mt-4 max-h-64 w-full"
      >
        <path
          d="M10 10H630 M10 80H630 M10 150H630"
          className="stroke-chart-grid"
          fill="none"
          strokeWidth="0.5"
        />
        {r.days.map((day, i) => {
          // Exact metric strings stay intact; only bounded drawing coordinates use Number.
          const height = maximum
            ? Number((spendUnits(day.spend_decimal) * 1400n) / maximum) / 10
            : 0
          return (
            <rect
              key={day.date}
              className="text-chart-primary"
              x={10 + width * (i + 0.5) - barWidth / 2}
              y={150 - height}
              width={barWidth}
              height={height}
              fill="currentColor"
            >
              <title>
                {formatCalendarDate(day.date)}:{' '}
                {amount(day.spend_decimal, r.currency)}
              </title>
            </rect>
          )
        })}
        <text
          x={Math.max(60, 10 + width / 2)}
          y="178"
          textAnchor="middle"
          className="fill-current text-xs"
        >
          {formatCalendarDate(r.days[0]!.date)}
        </text>
        {r.days.length > 1 ? (
          <text
            x={Math.min(580, 630 - width / 2)}
            y="178"
            textAnchor="middle"
            className="fill-current text-xs"
          >
            {formatCalendarDate(r.days.at(-1)!.date)}
          </text>
        ) : null}
      </svg>
    </figure>
  )
}
