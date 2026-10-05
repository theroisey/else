import { useState } from 'react'
import { Button, Table } from '../../components/ui'
import type { Report, Workspace } from './models'

const dimensionLabels: Record<string, string> = { date: 'Property date', sessionDefaultChannelGroup: 'Session channel', deviceCategory: 'Device', landingPage: 'Landing page' }
function day(value: string) { return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` }
export function ReportTable({ title, report, definitions }: { title: string; report: Report; definitions: Workspace['definitions'] }) {
  const [page, setPage] = useState(0)
  const rows = report.rows.slice(page * 25, (page + 1) * 25)
  return <section className="mt-6">
    <h2 className="mb-3 text-lg font-semibold">{title}</h2>
    {!report.rows.length ? <p role="status" className="rounded-md border border-line p-4 text-muted">No observations for {title.toLowerCase()} in this period.</p> : <>
      <Table caption={`${title} · ${report.since} to ${report.until}`}><thead><tr>{report.dimensions.map(v => <th key={v}>{dimensionLabels[v]}</th>)}{definitions.map(v => <th className="text-right" key={v.name}>{v.display_name}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={JSON.stringify(row.dimensions)}>{row.dimensions.map((v, i) => <td className={report.dimensions[i] === 'date' ? 'whitespace-nowrap' : report.dimensions[i] === 'landingPage' ? 'max-w-xs break-all' : 'max-w-xs break-words'} key={report.dimensions[i]}>{report.dimensions[i] === 'date' ? day(v) : v}</td>)}{row.metrics.map((v, i) => <td className="whitespace-nowrap tabular-nums text-right" key={definitions[i]!.name}>{v}</td>)}</tr>)}</tbody>
      </Table>
      <div className="mt-3 flex flex-wrap items-center gap-3" aria-label={`${title} pages`}>
        <Button size="compact" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Previous {title.toLowerCase()}</Button>
        <span className="text-xs text-muted">Rows {page * 25 + 1}–{page * 25 + rows.length} of {report.rows.length}</span>
        <Button size="compact" disabled={(page + 1) * 25 >= report.rows.length} onClick={() => setPage(v => v + 1)}>Next {title.toLowerCase()}</Button>
      </div>
    </>}
  </section>
}
export function DailyTrend({ report }: { report: Report }) {
  if (!report.rows.length) return null
  const counts = report.rows.map(row => BigInt(row.metrics[0]!))
  const maximum = counts.reduce((a, b) => a > b ? a : b, 0n)
  const width = 620 / report.rows.length
  const barWidth = Math.max(1, Math.min(24, width * 0.6))
  return <figure className="chart-panel" tabIndex={0}>
    <figcaption className="font-semibold">Daily active users</figcaption>
    <p className="mt-1 text-xs text-muted">Each bar represents a returned property date. Missing dates are not filled with zero. Exact values appear in the daily table.</p>
    <svg viewBox="0 0 640 190" role="img" aria-label="Daily active users bar chart" className="mt-4 max-h-64 w-full text-chart-primary">
      <path d="M10 10H630 M10 80H630 M10 150H630" className="stroke-chart-grid" fill="none" strokeWidth="0.5" />
      {counts.map((count, i) => {
        // Only bounded drawing coordinates use Number; measured values stay exact.
        const height = maximum ? Number(count * 1400n / maximum) / 10 : 0
        return <rect key={report.rows[i]!.dimensions[0]} x={10 + width * (i + 0.5) - barWidth / 2} y={150 - height} width={barWidth} height={height} fill="currentColor"><title>{day(report.rows[i]!.dimensions[0]!)}: {count.toString()} active users</title></rect>
      })}
      <text x={Math.max(60, 10 + width / 2)} y="178" textAnchor="middle" className="fill-current text-xs">{day(report.rows[0]!.dimensions[0]!)}</text>
      {report.rows.length > 1 ? <text x={Math.min(580, 630 - width / 2)} y="178" textAnchor="middle" className="fill-current text-xs">{day(report.rows.at(-1)!.dimensions[0]!)}</text> : null}
    </svg>
  </figure>
}
