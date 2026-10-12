import { currentLocale } from '../../i18n'
export function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString(currentLocale(), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—'
}
