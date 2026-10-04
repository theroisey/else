import { TextField } from '../../components/ui'
import { currencies } from './models'
import type { Currency, Period } from './models'

export function PeriodFields({ period, onChange, disabled }: { period: Period; onChange: (next: Period) => void; disabled: boolean }) {
  return <>
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Start date (UTC)" type="date" min="2000-01-01" max="9999-12-30" required value={period.start.slice(0, 10)} disabled={disabled} onChange={e => onChange({ ...period, start: e.target.value ? e.target.value + 'T00:00:00Z' : '' })} />
      <TextField label="End date (UTC, exclusive)" type="date" min="2000-01-02" max="9999-12-31" required value={period.end.slice(0, 10)} disabled={disabled} onChange={e => onChange({ ...period, end: e.target.value ? e.target.value + 'T00:00:00Z' : '' })} />
    </div>
    <label className="grid gap-2 text-sm font-semibold">Report currency<select className="min-w-0 rounded-md border border-line bg-surface px-3 py-2 font-normal" value={period.currency} disabled={disabled} onChange={e => onChange({ ...period, currency: e.target.value as Currency })}>
      {currencies.map(currency => <option key={currency} value={currency}>{currency}</option>)}
    </select></label>
    <p className="text-xs text-muted">Starts at 00:00 UTC on the start date and stops before 00:00 UTC on the end date, up to 31 days. Currency is explicit; amounts are never converted.</p>
  </>
}
