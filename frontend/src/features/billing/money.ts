export const exponents = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  TRY: 2,
  JPY: 0,
  KWD: 3,
} as const
export type Currency = keyof typeof exponents
export const maxInt64 = 9223372036854775807n
export function toMinor(input: string, currency: Currency) {
  const value = input.trim(),
    scale = exponents[currency]
  if (
    scale === undefined ||
    value.length > 24 ||
    !/^\d+(?:\.\d+)?$/.test(value)
  )
    throw new Error(
      'Enter a plain positive decimal amount without signs or separators.',
    )
  const [whole = '', fraction = ''] = value.split('.')
  if (fraction.length > scale)
    throw new Error(
      `Use at most ${scale} decimal places for ${currency}. Amounts are never rounded.`,
    )
  const minor = BigInt(whole + fraction.padEnd(scale, '0'))
  if (minor < 1n || minor > maxInt64)
    throw new Error('Amount is outside the supported positive range.')
  return String(minor)
}
export function decimal(minor: string, exponent: number) {
  if (!/^(0|[1-9]\d*)$/.test(minor) || ![0, 2, 3].includes(exponent))
    throw new Error('Invalid monetary value.')
  if (!exponent) return minor
  const padded = minor.padStart(exponent + 1, '0')
  return padded.slice(0, -exponent) + '.' + padded.slice(-exponent)
}
export function money(
  minor: string,
  currency: Currency,
  exponent: number = exponents[currency],
) {
  if (exponent !== exponents[currency])
    throw new Error('Invalid currency scale.')
  const [whole = '', fraction] = decimal(minor, exponent).split('.')
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : '.' + fraction}`
}
