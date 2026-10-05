import { copy, useLocale } from '../../i18n/index'
import { TextField } from '../../components/ui'
import type { Period } from './models'

export function PeriodFields({
  period,
  onChange,
  disabled = false,
  calendar = copy('GA4 property', 'analytics'),
}: {
  period: Period
  onChange: (value: Period) => void
  disabled?: boolean
  calendar?: string
}) {
  useLocale()
  return (
    <fieldset
      disabled={disabled}
      className="field-grid grid gap-3 sm:grid-cols-2"
    >
      <legend className="mb-2 text-sm text-muted">
        {copy('{{value1}} dates · Maximum 31 inclusive days', 'analytics', {
          value1: calendar,
        })}
      </legend>
      <TextField
        label={copy('Start date', 'analytics')}
        type="date"
        required
        min="2000-01-01"
        max="9999-12-31"
        value={period.since}
        onChange={(e) => onChange({ ...period, since: e.target.value })}
      />
      <TextField
        label={copy('End date', 'analytics')}
        type="date"
        required
        min="2000-01-01"
        max="9999-12-31"
        value={period.until}
        onChange={(e) => onChange({ ...period, until: e.target.value })}
      />
    </fieldset>
  )
}
