import { expect, it } from 'vitest'
import { toMinor, decimal, money } from './money'
import { dateSchema, parseCollection, parseSummary } from './models'
import { collection } from './fixtures.test-data'
it.each([
  ['USD', '000.01', '1'],
  ['EUR', '90071992547409.93', '9007199254740993'],
  ['GBP', '92233720368547758.07', '9223372036854775807'],
  ['TRY', '1.5', '150'],
  ['JPY', '123', '123'],
  ['KWD', '0.001', '1'],
] as const)('converts %s %s exactly', (currency, input, minor) =>
  expect(toMinor(input, currency)).toBe(minor),
)
it.each([
  '0',
  '0.00',
  '-1',
  '+1',
  '1e2',
  '1,000',
  '1.001',
  'NaN',
  'Infinity',
  '.01',
  '1.',
  '92233720368547758.08',
])('rejects invalid USD amount %s without rounding', (input) =>
  expect(() => toMinor(input, 'USD')).toThrow(),
)
it('rejects fractional JPY and excess KWD precision', () => {
  expect(() => toMinor('1.0', 'JPY')).toThrow()
  expect(() => toMinor('0.0001', 'KWD')).toThrow()
})
it('formats aggregate values above int64 without number conversion', () => {
  expect(money('18446744073709551614', 'USD')).toBe(
    'USD 184,467,440,737,095,516.14',
  )
  expect(decimal('1', 3)).toBe('0.001')
  expect(money('123', 'JPY')).toBe('JPY 123')
})
it.each(['0000-01-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01'])(
  'rejects invalid calendar date %s',
  (v) => expect(dateSchema.safeParse(v).success).toBe(false),
)
it('accepts calendar bounds/leap days and exact revisions', () => {
  for (const date of ['0001-01-01', '9999-12-31', '2028-02-29'])
    expect(dateSchema.safeParse(date).success).toBe(true)
  expect(parseCollection({ data: collection }).revision).toBe(
    '9007199254740993',
  )
})
it.each([
  { amount_minor: 10000 },
  { revision: 9007199254740992 },
  { amount_minor: '01' },
  { paid_minor: '1e2' },
  { amount_minor: '9223372036854775808' },
  { currency_exponent: 3 },
  { outstanding_minor: '1' },
  { status: 'paid' },
  { cancelled_at: collection.created_at },
])('rejects malformed or inconsistent collection %j', (patch) =>
  expect(() =>
    parseCollection({ data: { ...collection, ...patch } }),
  ).toThrow(),
)
it('rejects duplicate currency summaries and preserves totals above int64', () => {
  const t = {
    currency: 'USD',
    currency_exponent: 2,
    amount_minor: '18446744073709551614',
    paid_minor: '0',
    outstanding_minor: '18446744073709551614',
    overdue_minor: '0',
    cancelled_amount_minor: '0',
    cancelled_paid_minor: '0',
  }
  expect(parseSummary({ data: [t] })[0]?.amount_minor).toBe(t.amount_minor)
  expect(() => parseSummary({ data: [t, t] })).toThrow()
})
