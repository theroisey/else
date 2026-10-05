import { currentLocale } from './locale.ts'

export function formatDate(
  value: string | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  return new Intl.DateTimeFormat(currentLocale(), options).format(
    value instanceof Date ? value : new Date(value),
  )
}
export function formatNumber(
  value: string | number | bigint,
  options: Intl.NumberFormatOptions = {},
) {
  // Intl accepts decimal strings exactly in modern browsers. Never coerce large
  // business values through Number, which discards integer/fraction precision.
  return new Intl.NumberFormat(currentLocale(), options).format(value as number)
}
export function formatDecimal(value: string, fractionDigits?: number) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value))
    throw new Error('Invalid decimal value.')
  const scale = fractionDigits ?? value.split('.')[1]?.length ?? 0
  return formatNumber(value, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  })
}
export function formatCurrency(
  value: string,
  currency: string,
  exponent: number,
) {
  const formatted = formatNumber(value, {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })
  return currentLocale() === 'en'
    ? formatted.replace(currency + '\u00a0', currency + ' ')
    : formatted
}
export function formatRelative(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
) {
  return new Intl.RelativeTimeFormat(currentLocale(), {
    numeric: 'auto',
  }).format(value, unit)
}
export function formatCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
) {
  // A business calendar date is not an instant: retain its recorded day in UTC.
  return formatDate(value.length === 10 ? value + 'T00:00:00Z' : value, {
    ...options,
    timeZone: 'UTC',
  })
}
export function formatPercent(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error('Invalid percentage value.')
  const scale = value.split('.')[1]?.length ?? 0
  const digits = value.replace('.', '').padStart(scale + 3, '0')
  const point = digits.length - scale - 2
  const fraction = digits.slice(0, point) + '.' + digits.slice(point)
  return formatNumber(fraction, {
    style: 'percent',
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  })
}

// Stored schedules can distinguish instants inside the same millisecond. Intl
// formats the date, clock and decimal separator; the original fractional
// second replaces its three-digit limit so no precision is silently discarded.
export function formatPreciseTime(value: string, timezone: string) {
  const fraction = /\.(\d+)Z$/.exec(value)?.[1]?.replace(/0+$/, '') ?? ''
  return new Intl.DateTimeFormat(currentLocale(), {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    ...(fraction ? { fractionalSecondDigits: 3 as const } : {}),
  })
    .formatToParts(new Date(value))
    .map((part) => (part.type === 'fractionalSecond' ? fraction : part.value))
    .join('')
}
