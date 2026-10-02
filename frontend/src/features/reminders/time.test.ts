import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { occurrences, wallClock, utcFromWall, validZone, offsetLabel } from './time'
it('offers both explicit DST occurrences with original microseconds', () => {
  expect(occurrences('2026-11-01T01:30:00.123456', 'America/New_York')).toEqual([
    { offset: -14400, utc: '2026-11-01T05:30:00.123456Z' },
    { offset: -18000, utc: '2026-11-01T06:30:00.123456Z' },
  ])
  expect(occurrences('2026-04-05T01:45:00', 'Australia/Lord_Howe')).toEqual([
    { offset: 39600, utc: '2026-04-04T14:45:00Z' },
    { offset: 37800, utc: '2026-04-04T15:15:00Z' },
  ])
  expect(occurrences('2026-10-02T12:00:00.1', 'Asia/Kathmandu')).toEqual([
    { offset: 20700, utc: '2026-10-02T06:15:00.1Z' },
  ])
})
it('rejects gaps and skipped dates without normalizing the wall clock', () => {
  for (const [local, zone] of [
    ['2026-03-08T02:30:00', 'America/New_York'],
    ['2026-10-04T02:15:00', 'Australia/Lord_Howe'],
    ['2011-12-30T12:00:00', 'Pacific/Apia'],
  ])
    expect(occurrences(local!, zone!)).toEqual([])
})
it('validates calendar, zone, precision and UTC/local year bounds', () => {
  for (const value of [
    '0000-01-01T00:00',
    '2026-02-30T12:00',
    '2026-10-02T24:00',
    '2026-10-02T12:00:60',
    '2026-10-02T12:00:00.1234567',
    '2026-10-02T12:00Z',
    'unsafe',
  ])
    expect(() => wallClock(value)).toThrow()
  for (const value of ['Local', 'GMT+02:00', '../../etc/passwd', 'Unknown/Zone'])
    expect(validZone(value)).toBe(false)
  expect(occurrences('0001-01-01T00:00:00', 'UTC')).toEqual([
    { offset: 0, utc: '0001-01-01T00:00:00Z' },
  ])
  expect(occurrences('9999-12-31T23:59:59.999999', 'UTC')).toEqual([
    { offset: 0, utc: '9999-12-31T23:59:59.999999Z' },
  ])
  expect(() => utcFromWall('0001-01-01T00:00:00', 3600)).toThrow()
  expect(() => utcFromWall('9999-12-31T23:59:59', -3600)).toThrow()
  expect(() => utcFromWall('2026-10-02T12:00', 86400)).toThrow()
  expect(wallClock('2026-10-02T12:00:00.120000').local).toBe('2026-10-02T12:00:00.12')
})
it('handles historical second offsets and names them without rounding', () => {
  expect(occurrences('1840-01-01T12:00:00.000001', 'America/New_York')).toEqual([
    { offset: -17762, utc: '1840-01-01T16:56:02.000001Z' },
  ])
  expect(offsetLabel(-17762)).toBe('UTC−04:56:02')
})
it('uses the requested zone independently of the host timezone', () => {
  const module = pathToFileURL(resolve('src/features/reminders/time.ts')).href
  const script = `import {occurrences} from ${JSON.stringify(module)}; console.log(JSON.stringify(occurrences('2026-11-01T01:30:00.123456','America/New_York')))`
  const results = ['UTC', 'Europe/Istanbul', 'Pacific/Apia'].map((TZ) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ },
      encoding: 'utf8',
    }),
  )
  expect(new Set(results).size).toBe(1)
})
