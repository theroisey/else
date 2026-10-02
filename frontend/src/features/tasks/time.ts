import type { Summary } from './models'

export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
export function formatTime(value: string, timezone = deviceTimezone()) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value))
}
// PostgreSQL responses have microsecond precision; retain it when comparing instants.
export function instant(value: string) {
  const tail = /\.(\d+)/.exec(value)?.[1] ?? ''
  return BigInt(Date.parse(value)) * 1000n + BigInt(tail.slice(3, 6).padEnd(3, '0') || '0')
}
export function localInput(value: string | null) {
  if (!value) return ''
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export function localTimestamp(value: string, original: string | null = null) {
  if (!value) return null
  const normalized = value.length === 16 ? value + ':00' : value
  if (original && normalized === localInput(original)) return original
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error('Enter a valid local date and time.')
  const d = new Date(value)
  if (
    !Number.isFinite(d.getTime()) ||
    localInput(d.toISOString()) !== normalized ||
    d.getUTCFullYear() < 1 ||
    d.getUTCFullYear() > 9999
  )
    throw new Error('This local date and time does not exist. Choose another time.')
  return d.toISOString()
}
export function dueState(
  task: Pick<Summary, 'status' | 'archived_at' | 'due_at'>,
  now = Date.now(),
) {
  if (!task.due_at || task.archived_at || ['done', 'cancelled'].includes(task.status)) return null
  const due = instant(task.due_at),
    current = BigInt(Math.trunc(now)) * 1000n
  if (due <= current) return 'Overdue'
  return due <= current + 86_400_000_000n ? 'Due within 24 hours' : null
}
