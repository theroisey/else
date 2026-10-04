import { useState } from 'react'
import { Button, Table } from '../../components/ui'
import { amount, spendUnits } from './models'
import type { Workspace } from './models'

export function MetaTables({ data }: { data: Workspace }) {
  const [page, setPage] = useState(0)
  const r = data.report, visible = r.days.slice(page * 25, (page + 1) * 25)
  return <section className="mt-6">
    <h2 className="mb-3 text-lg font-semibold">Daily account observations</h2>
    {!r.days.length ? <p role="status" className="rounded-md border border-line p-4 text-muted">No daily observations were reported for this period.</p> : <>
      <Table caption="Daily account observations"><thead><tr>{['Account date', 'Spend', 'Impressions', 'Clicks', 'CTR', 'CPC', 'CPM'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{visible.map(day => <tr key={day.date}>{[day.date, amount(day.spend_decimal, r.currency), day.impressions, day.clicks,
          day.ctr_percent === null ? 'Unavailable' : day.ctr_percent + '%', day.cpc_decimal === null ? 'Unavailable' : amount(day.cpc_decimal, r.currency),
          day.cpm_decimal === null ? 'Unavailable' : amount(day.cpm_decimal, r.currency)].map((cell, i) => <td className="whitespace-nowrap tabular-nums" key={i}>{cell}</td>)}</tr>)}</tbody>
      </Table>
      <div className="mt-3 flex flex-wrap items-center gap-3" aria-label="Daily account observation pages">
        <Button size="compact" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Previous observations</Button>
        <span className="text-xs text-muted">Rows {page * 25 + 1}–{page * 25 + visible.length} of {r.days.length}</span>
        <Button size="compact" disabled={(page + 1) * 25 >= r.days.length} onClick={() => setPage(v => v + 1)}>Next observations</Button>
      </div>
    </>}
  </section>
}
export function DailySpend({ data }: { data: Workspace }) {
  const r = data.report
  if (!r.days.length) return null
  const maximum = r.days.reduce((max, day) => { const value = spendUnits(day.spend_decimal); return value > max ? value : max }, 0n)
  const width = 620 / r.days.length
  return <figure className="mt-6 rounded-md border border-line bg-surface p-4">
    <figcaption className="font-semibold">Daily observed spend · {r.currency}</figcaption>
    <p className="mt-1 text-xs text-muted">Only observed ad-account dates are shown. Missing days remain unmeasured.</p>
    <svg viewBox="0 0 640 190" role="img" aria-label="Daily observed Meta spend" className="mt-4 max-h-64 w-full">
      {r.days.map((day, i) => {
        // Exact metric strings stay intact; only bounded drawing coordinates use Number.
        const height = maximum ? Number(spendUnits(day.spend_decimal) * 1400n / maximum) / 10 : 0
        return <rect key={day.date} className="text-accent-ink" x={10 + width * i} y={150 - height} width={Math.max(1, width - 2)} height={height} fill="currentColor"><title>{day.date}: {amount(day.spend_decimal, r.currency)}</title></rect>
      })}
      <text x="10" y="178" className="fill-current text-xs">{r.days[0]!.date}</text><text x="630" y="178" textAnchor="end" className="fill-current text-xs">{r.days.at(-1)!.date}</text>
    </svg>
  </figure>
}
