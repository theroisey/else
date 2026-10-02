import type { Summary } from './models'
import { instant } from '../../lib/time'
export { deviceTimezone, formatTime, instant, localInput, localTimestamp } from '../../lib/time'

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
