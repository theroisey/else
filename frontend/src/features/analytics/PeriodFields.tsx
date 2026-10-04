import { TextField } from '../../components/ui'
import type { Period } from './models'

export function PeriodFields({ period, onChange, disabled = false, calendar = 'GA4 property' }: { period: Period; onChange: (value: Period) => void; disabled?: boolean; calendar?: string }) {
  return <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
    <legend className="mb-2 text-sm text-muted">{calendar} dates · Maximum 31 inclusive days</legend>
    <TextField label="Start date" type="date" required min="2000-01-01" max="9999-12-31" value={period.since} onChange={e => onChange({ ...period, since: e.target.value })} />
    <TextField label="End date" type="date" required min="2000-01-01" max="9999-12-31" value={period.until} onChange={e => onChange({ ...period, until: e.target.value })} />
  </fieldset>
}
