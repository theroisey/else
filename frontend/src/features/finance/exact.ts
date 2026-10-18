import { formatCurrency, formatNumber } from '../../i18n/format'
import { exponents } from '../billing/money'
import type { Currency } from '../billing/money'
export function amount(value: string, currency: Currency) {
  if (!/^(0|-?[1-9]\d*)$/.test(value)) throw Error('Invalid amount')
  const scale = exponents[currency],
    negative = value.startsWith('-')
  const raw = (negative ? value.slice(1) : value).padStart(scale + 1, '0')
  return formatCurrency(
    (negative ? '-' : '') +
      (scale ? raw.slice(0, -scale) + '.' + raw.slice(-scale) : raw),
    currency,
    scale,
  )
}
export function percent(part: string, total: string) {
  const a = BigInt(part),
    b = BigInt(total)
  if (b <= 0n) return null
  const sign = a < 0n ? '-' : ''
  const magnitude = a < 0n ? -a : a
  const bps = (magnitude * 10000n + b / 2n) / b
  return formatNumber(
    `${sign}${bps / 10000n}.${String(bps % 10000n).padStart(4, '0')}`,
    { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 },
  )
}
export function average(value: string, count: string) {
  const n = BigInt(count),
    v = BigInt(value)
  if (n <= 0n) return null
  const sign = v < 0n ? -1n : 1n
  return String(sign * ((v * sign + n / 2n) / n))
}
export function coordinate(value: string, max: bigint, height = 160) {
  if (max <= 0n) return 0
  return Number((BigInt(value) * BigInt(height * 1000)) / max) / 1000
}
