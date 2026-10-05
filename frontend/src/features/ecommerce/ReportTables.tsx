import { formatCalendarDate, formatNumber } from '../../i18n/format'
import { formatTime } from '../../lib/time'
import { orderStatusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Table } from '../../components/ui'
import { dailyObservations, money } from './models'
import type { Workspace } from './models'

function PagedTable<T>({
  title,
  rows,
  columns,
  cells,
  textColumns = [0],
}: {
  title: string
  rows: T[]
  columns: string[]
  cells: (row: T) => ReactNode[]
  textColumns?: number[]
}) {
  useLocale()
  const [page, setPage] = useState(0)
  const visible = rows.slice(page * 25, (page + 1) * 25)
  return (
    <section className="mt-6">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {!rows.length ? (
        <p
          role="status"
          className="rounded-md border border-line p-4 text-muted"
        >
          {copy('No observations for {{value1}} in this period.', 'commerce', {
            value1: title.toLowerCase(),
          })}
        </p>
      ) : (
        <>
          <Table caption={title}>
            <thead>
              <tr>
                {columns.map((column, index) => (
                  <th
                    className={!textColumns.includes(index) ? 'text-right' : ''}
                    key={column}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <tr key={page * 25 + i}>
                  {cells(row).map((cell, j) => (
                    <td
                      className={`whitespace-nowrap tabular-nums ${!textColumns.includes(j) ? 'text-right' : ''}`}
                      key={columns[j]}
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
            aria-label={copy('{{value1}} pages', 'commerce', { value1: title })}
          >
            <Button
              size="compact"
              disabled={page === 0}
              onClick={() => setPage((v) => v - 1)}
            >
              {copy('Previous {{value1}}', 'commerce', {
                value1: title.toLowerCase(),
              })}
            </Button>
            <span className="text-xs text-muted">
              {copy('Rows {{value1}}–{{value2}} of {{value3}}', 'commerce', {
                value1: page * 25 + 1,
                value2: page * 25 + visible.length,
                value3: rows.length,
              })}
            </span>
            <Button
              size="compact"
              disabled={(page + 1) * 25 >= rows.length}
              onClick={() => setPage((v) => v + 1)}
            >
              {copy('Next {{value1}}', 'commerce', {
                value1: title.toLowerCase(),
              })}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
export function CommerceTables({ data }: { data: Workspace }) {
  useLocale()
  const currency = data.orders.currency
  return (
    <>
      <PagedTable
        title={copy('Order-created cohort', 'commerce')}
        rows={data.orders.orders}
        textColumns={[0, 1, 2]}
        columns={[
          copy('Order ID', 'commerce'),
          copy('Created (UTC)', 'commerce'),
          copy('Status', 'commerce'),
          copy('Grand total', 'commerce'),
          copy('Lifetime refunded', 'commerce'),
          copy('Remaining grand', 'commerce'),
        ]}
        cells={(row) => [
          row.id,
          formatTime(row.created_at, 'UTC'),
          orderStatusLabel(row.status),
          money(row.grand_total_minor, currency),
          money(row.lifetime_refund_minor, currency),
          money(row.remainder_minor, currency),
        ]}
      />
      <p className="mt-2 text-xs text-muted">
        {copy(
          'All reported statuses are included. Lifetime refunds may be created outside the period. Remaining grand totals do not prove payment or recognized revenue.',
          'commerce',
        )}
      </p>
      <PagedTable
        title={copy('Refund-created events', 'commerce')}
        rows={data.refunds.refunds}
        textColumns={[0, 1, 2]}
        columns={[
          copy('Refund ID', 'commerce'),
          copy('Parent order ID', 'commerce'),
          copy('Created (UTC)', 'commerce'),
          copy('Amount', 'commerce'),
        ]}
        cells={(row) => [
          row.id,
          row.parent_id,
          formatTime(row.created_at, 'UTC'),
          money(row.amount_minor, currency),
        ]}
      />
      <p className="mt-2 text-xs text-muted">
        {copy(
          'These events were created in this UTC period. Parent orders can belong to an older period; their currencies were checked independently.',
          'commerce',
        )}
      </p>
      <PagedTable
        title={copy('Original product lines', 'commerce')}
        rows={data.products.products}
        columns={[
          copy('Product ID', 'commerce'),
          copy('Variation ID', 'commerce'),
          copy('Quantity', 'commerce'),
          copy('Orders', 'commerce'),
          copy('Lines', 'commerce'),
          copy('Line net', 'commerce'),
          copy('Line tax', 'commerce'),
          copy('Line grand', 'commerce'),
        ]}
        cells={(row) => [
          row.product_id === '0'
            ? copy('0 (unknown/deleted)', 'commerce')
            : row.product_id,
          row.variation_id === '0'
            ? copy('0 (none or unknown)', 'commerce')
            : row.variation_id,
          formatNumber(row.quantity),
          formatNumber(row.order_count),
          formatNumber(row.line_count),
          money(row.total_minor, currency),
          money(row.tax_minor, currency),
          money(row.line_grand_minor, currency),
        ]}
      />
      <p className="mt-2 text-xs text-muted">
        {copy(
          'Grouped original lines from the all-status order-created cohort. Quantities retain exact reported integers. Product names, stock, paid sales and refund-line allocations are unavailable. Line components can differ from order grand totals, for example because of shipping.',
          'commerce',
        )}
      </p>
    </>
  )
}
export function DailyTrend({ data }: { data: Workspace }) {
  useLocale()
  const days = dailyObservations(data)
  if (!days.length) return null
  const maximum = days.reduce<bigint>(
    (largest, row) =>
      [row.orderGrand, row.refundAmount].reduce<bigint>(
        (max, amount) => (amount !== null && amount > max ? amount : max),
        largest,
      ),
    0n,
  )
  const width = 620 / days.length
  const barWidth = Math.max(1, Math.min(18, width * 0.3))
  return (
    <figure className="chart-panel" tabIndex={0}>
      <figcaption className="font-semibold">
        {copy('Daily observed amounts (UTC)', 'commerce')}
      </figcaption>
      <p className="mt-1 text-xs text-muted">
        <span className="text-chart-primary">
          {copy('Order-created grand totals', 'commerce')}
        </span>{' '}
        ·{' '}
        <span className="text-chart-secondary">
          {copy('Refund-created amounts', 'commerce')}
        </span>
        {copy(
          '. Different cohorts are shown separately and never netted. Missing dates or series are not filled with zero.',
          'commerce',
        )}
      </p>
      <svg
        viewBox="0 0 640 190"
        role="img"
        aria-label={copy('Daily observed order totals and refunds', 'commerce')}
        className="mt-4 max-h-64 w-full"
      >
        <path
          d="M10 10H630 M10 80H630 M10 150H630"
          className="stroke-chart-grid"
          fill="none"
          strokeWidth="0.5"
        />
        {days.flatMap((row, i) =>
          [row.orderGrand, row.refundAmount].map((amount, series) => {
            if (amount === null) return null
            // Only bounded drawing coordinates use Number; monetary values stay exact.
            const height = maximum ? Number((amount * 1400n) / maximum) / 10 : 0
            return (
              <rect
                key={`${row.day}-${series}`}
                className={
                  series === 0 ? 'text-chart-primary' : 'text-chart-secondary'
                }
                x={10 + width * (i + 0.5) + (series === 0 ? -barWidth - 1 : 1)}
                y={150 - height}
                width={barWidth}
                height={height}
                fill="currentColor"
              >
                <title>
                  {formatCalendarDate(row.day)}:{' '}
                  {series === 0
                    ? copy('Order-created grand', 'commerce')
                    : copy('Refund-created amount', 'commerce')}{' '}
                  {money(amount.toString(), data.orders.currency)}
                </title>
              </rect>
            )
          }),
        )}
        <text
          x={Math.max(60, 10 + width / 2)}
          y="178"
          textAnchor="middle"
          className="fill-current text-xs"
        >
          {formatCalendarDate(days[0]!.day)}
        </text>
        {days.length > 1 ? (
          <text
            x={Math.min(580, 630 - width / 2)}
            y="178"
            textAnchor="middle"
            className="fill-current text-xs"
          >
            {formatCalendarDate(days.at(-1)!.day)}
          </text>
        ) : null}
      </svg>
    </figure>
  )
}
