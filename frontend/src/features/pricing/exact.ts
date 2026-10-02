import { exponents, maxInt64 } from '../billing/money'
import type { Currency } from '../billing/money'
// Inputs are never rounded. Number is reserved for nonfinancial UI positions.
export function scaled(
  input: string,
  places: number,
  positive = false,
  maximum = maxInt64,
) {
  const v = input.trim()
  if (v.length > 30 || !/^\d+(?:\.\d+)?$/.test(v))
    throw new Error('Enter a plain decimal without signs or separators.')
  const [whole = '', fraction = ''] = v.split('.')
  if (fraction.length > places)
    throw new Error(
      `Use at most ${places} decimal places. Inputs are never rounded.`,
    )
  const n = BigInt(whole + fraction.padEnd(places, '0'))
  if (n > maximum || (positive && n === 0n))
    throw new Error('Value is outside the supported range.')
  return String(n)
}
export const priceInput = (v: string, c: Currency) => scaled(v, exponents[c])
export const quantityInput = (v: string) => scaled(v, 6, true)
export const percentInput = (v: string) => scaled(v, 2, false, 10000n)
export function unscaled(value: string, places: number) {
  const padded = value.padStart(places + 1, '0')
  if (!places) return value
  return padded.slice(0, -places) + '.' + padded.slice(-places)
}
export const utcToday = () => new Date().toISOString().slice(0, 10)
export const halfUp = (a: string, b: string, divisor: bigint) =>
  (BigInt(a) * BigInt(b) + divisor / 2n) / divisor
