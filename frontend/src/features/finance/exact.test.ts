// @vitest-environment node
import { expect, it } from 'vitest'
import { amount, percent, coordinate, average } from './exact'
import { periodRange } from './periods'
it('retains large values, signed amounts, JPY and KWD precision without float arithmetic', () => {
  expect(amount('18446744073709551614', 'EUR')).toContain(
    '184,467,440,737,095,516.14',
  )
  expect(amount('-50000', 'EUR')).toContain('-')
  expect(amount('1000', 'JPY')).toContain('1,000')
  expect(amount('1001', 'KWD')).toContain('1.001')
  expect(percent('20000', '70000')).toBe('28.57%')
  expect(percent('0', '0')).toBeNull()
  expect(percent('-50', '100')).toBe('-50.00%')
  expect(average('35000', '2')).toBe('17500')
  expect(average('1', '0')).toBeNull()
  expect(coordinate('9223372036854775807000', 9223372036854775807000n)).toBe(
    160,
  )
})
it('uses UTC calendar presets across leap days, quarter and year boundaries', () => {
  const day = new Date('2024-03-01T00:15:00Z')
  expect(periodRange('Last month', day)).toEqual({
    from: '2024-02-01',
    to: '2024-02-29',
  })
  expect(periodRange('Yesterday', day)).toEqual({
    from: '2024-02-29',
    to: '2024-02-29',
  })
  expect(periodRange('Last quarter', day)).toEqual({
    from: '2023-10-01',
    to: '2023-12-31',
  })
  expect(periodRange('Last year', day)).toEqual({
    from: '2023-01-01',
    to: '2023-12-31',
  })
  expect(periodRange('All time', day).from).toBe('0001-01-01')
})
