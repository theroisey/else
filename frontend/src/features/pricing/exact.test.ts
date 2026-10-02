import { it, expect } from 'vitest'
import { priceInput, quantityInput, percentInput, halfUp } from './exact'
it.each([
  ['USD', '1.01', '101'],
  ['EUR', '0.00', '0'],
  ['GBP', '90071992547409.93', '9007199254740993'],
  ['TRY', '1', '100'],
  ['JPY', '100', '100'],
  ['KWD', '1.001', '1001'],
] as const)('converts exact %s prices', (c, v, w) =>
  expect(priceInput(v, c)).toBe(w),
)
it.each(['1e3', '-1', '+1', '1,000', 'NaN', '1.001', '92233720368547758.08'])(
  'rejects unsupported price %s without rounding',
  (v) => expect(() => priceInput(v, 'USD')).toThrow(),
)
it.each([
  ['1', '1000000'],
  ['0.000001', '1'],
  ['1.500000', '1500000'],
  ['9223372036854.775807', '9223372036854775807'],
])('converts exact quantity %s', (v, w) => expect(quantityInput(v)).toBe(w))
it.each(['0', '0.0000001', '1e3', '-1'])('rejects invalid quantity %s', (v) =>
  expect(() => quantityInput(v)).toThrow(),
)
it.each([
  ['0', '0'],
  ['25', '2500'],
  ['1.25', '125'],
  ['100.00', '10000'],
])('converts exact percent %s', (v, w) => expect(percentInput(v)).toBe(w))
it.each(['100.01', '1.001', '-1', '1e2'])(
  'rejects invalid percentage %s',
  (v) => expect(() => percentInput(v)).toThrow(),
)
it('retains half-up ties and arbitrary-width intermediates', () => {
  expect(halfUp('1500000', '1', 1000000n)).toBe(2n)
  expect(halfUp('1000000', '9223372036854775807', 1000000n)).toBe(
    9223372036854775807n,
  )
})
