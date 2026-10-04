import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Table } from '../../components/ui'
import { dailyObservations, money } from './models'
import type { Workspace } from './models'

function PagedTable<T>({ title, rows, columns, cells }: { title: string; rows: T[]; columns: string[]; cells: (row: T) => ReactNode[] }) {
  const [page, setPage] = useState(0)
  const visible = rows.slice(page * 25, (page + 1) * 25)
  return <section className="mt-6">
    <h2 className="mb-3 text-lg font-semibold">{title}</h2>
    {!rows.length ? <p role="status" className="rounded-md border border-line p-4 text-muted">No observations for {title.toLowerCase()} in this period.</p> : <>
      <Table caption={title}><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{visible.map((row, i) => <tr key={page * 25 + i}>{cells(row).map((cell, j) => <td className="whitespace-nowrap tabular-nums" key={columns[j]}>{cell}</td>)}</tr>)}</tbody>
      </Table>
      <div className="mt-3 flex flex-wrap items-center gap-3" aria-label={`${title} pages`}>
        <Button size="compact" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Previous {title.toLowerCase()}</Button>
        <span className="text-xs text-muted">Rows {page * 25 + 1}–{page * 25 + visible.length} of {rows.length}</span>
        <Button size="compact" disabled={(page + 1) * 25 >= rows.length} onClick={() => setPage(v => v + 1)}>Next {title.toLowerCase()}</Button>
      </div>
    </>}
  </section>
}
export function CommerceTables({ data }: { data: Workspace }) {
  const currency = data.orders.currency
  return <>
    <PagedTable title="Order-created cohort" rows={data.orders.orders} columns={['Order ID', 'Created (UTC)', 'Status', 'Grand total', 'Lifetime refunded', 'Remaining grand']} cells={row => [row.id, row.created_at, row.status, money(row.grand_total_minor, currency), money(row.lifetime_refund_minor, currency), money(row.remainder_minor, currency)]} />
    <p className="mt-2 text-xs text-muted">All reported statuses are included. Lifetime refunds may be created outside the period. Remaining grand totals do not prove payment or recognized revenue.</p>
    <PagedTable title="Refund-created events" rows={data.refunds.refunds} columns={['Refund ID', 'Parent order ID', 'Created (UTC)', 'Amount']} cells={row => [row.id, row.parent_id, row.created_at, money(row.amount_minor, currency)]} />
    <p className="mt-2 text-xs text-muted">These events were created in this UTC period. Parent orders can belong to an older period; their currencies were checked independently.</p>
    <PagedTable title="Original product lines" rows={data.products.products} columns={['Product ID', 'Variation ID', 'Quantity', 'Orders', 'Lines', 'Line net', 'Line tax', 'Line grand']} cells={row => [row.product_id === '0' ? '0 (unknown/deleted)' : row.product_id, row.variation_id === '0' ? '0 (none or unknown)' : row.variation_id, row.quantity, row.order_count, row.line_count, money(row.total_minor, currency), money(row.tax_minor, currency), money(row.line_grand_minor, currency)]} />
    <p className="mt-2 text-xs text-muted">Grouped original lines from the all-status order-created cohort. Quantities retain exact reported integers. Product names, stock, paid sales and refund-line allocations are unavailable. Line components can differ from order grand totals, for example because of shipping.</p>
  </>
}
export function DailyTrend({ data }: { data: Workspace }) {
  const days = dailyObservations(data)
  if (!days.length) return null
  const maximum = days.reduce<bigint>((largest, row) => [row.orderGrand, row.refundAmount].reduce<bigint>((max, amount) => amount !== null && amount > max ? amount : max, largest), 0n)
  const width = 620 / days.length
  return <figure className="mt-6 rounded-md border border-line bg-surface p-4">
    <figcaption className="font-semibold">Daily observed amounts (UTC)</figcaption>
    <p className="mt-1 text-xs text-muted"><span className="text-accent-ink">Order-created grand totals</span> · <span className="text-warning-ink">Refund-created amounts</span>. Different cohorts are shown separately and never netted. Missing dates or series are not filled with zero.</p>
    <svg viewBox="0 0 640 190" role="img" aria-label="Daily observed order totals and refunds" className="mt-4 max-h-64 w-full">
      {days.flatMap((row, i) => [row.orderGrand, row.refundAmount].map((amount, series) => {
        if (amount === null) return null
        // Only bounded drawing coordinates use Number; monetary values stay exact.
        const height = maximum ? Number(amount * 1400n / maximum) / 10 : 0
        return <rect key={`${row.day}-${series}`} className={series === 0 ? 'text-accent-ink' : 'text-warning-ink'} x={10 + width * i + width * series / 2} y={150 - height} width={Math.max(1, width / 2 - 2)} height={height} fill="currentColor"><title>{row.day}: {series === 0 ? 'Order-created grand' : 'Refund-created amount'} {money(amount.toString(), data.orders.currency)}</title></rect>
      }))}
      <text x="10" y="178" className="fill-current text-xs">{days[0]!.day}</text><text x="630" y="178" textAnchor="end" className="fill-current text-xs">{days.at(-1)!.day}</text>
    </svg>
  </figure>
}
