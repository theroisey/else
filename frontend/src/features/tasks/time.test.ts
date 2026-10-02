import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { dueState, formatTime, instant, localTimestamp } from './time'

it('compares due instants at the exact overdue and 24-hour boundaries', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const task = { status: 'todo' as const, archived_at: null, due_at: '2026-10-02T14:00:00+02:00' }
  expect(dueState(task, now)).toBe('Overdue')
  expect(dueState({ ...task, due_at: '2026-10-02T12:00:00.000100Z' }, now)).toBe(
    'Due within 24 hours',
  )
  expect(dueState({ ...task, due_at: '2026-10-03T12:00:00Z' }, now)).toBe('Due within 24 hours')
  expect(dueState({ ...task, due_at: '2026-10-03T12:00:00.000001Z' }, now)).toBeNull()
  expect(dueState({ ...task, due_at: null }, now)).toBeNull()
  expect(dueState({ ...task, status: 'done' }, now)).toBeNull()
  expect(dueState({ ...task, status: 'cancelled' }, now)).toBeNull()
  expect(dueState({ ...task, archived_at: '2026-10-02T12:00:00Z' }, now)).toBeNull()
  expect(instant('2026-10-02T12:00:00.123456Z')).toBe(instant('2026-10-02T14:00:00.123456+02:00'))
})
it('renders the same instant in the requested timezone', () => {
  expect(formatTime('2026-10-02T00:30:00Z', 'America/New_York')).not.toBe(
    formatTime('2026-10-02T00:30:00Z', 'UTC'),
  )
  expect(localTimestamp('')).toBeNull()
  expect(() => localTimestamp('2026-02-30T10:00')).toThrow()
  expect(() => localTimestamp('unsafe')).toThrow()
})
it('rejects nonexistent DST times and preserves the original overlapping-hour instant', () => {
  const module = pathToFileURL(resolve('src/lib/time.ts')).href
  const script = `import {localTimestamp} from ${JSON.stringify(module)};
  let rejected=false;try {localTimestamp('2026-03-08T02:30')} catch {rejected=true}
  console.log(JSON.stringify({rejected,changed:localTimestamp('2026-11-01T01:30'),unchanged:localTimestamp('2026-11-01T01:30','2026-11-01T06:30:00.123456Z')}))`
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    }),
  )
  expect(result).toEqual({
    rejected: true,
    changed: '2026-11-01T05:30:00.000Z',
    unchanged: '2026-11-01T06:30:00.123456Z',
  })
})
