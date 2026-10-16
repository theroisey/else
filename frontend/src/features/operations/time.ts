import { formatDate } from '../../i18n/format'
export function time(value: string | null) {
  return value
    ? formatDate(value, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—'
}
