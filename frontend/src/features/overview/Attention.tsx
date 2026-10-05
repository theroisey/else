import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { Link } from 'react-router'
import { formatTime } from '../../lib/time'
import { statusLabels } from '../tasks/models'
import type { DueTask, DueReminder, Queue } from './models'

export function TaskQueue({
  heading,
  queue,
  client,
  empty,
}: {
  heading: string
  queue: Queue<DueTask>
  client: string
  empty: string
}) {
  useLocale()
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {queue.items.length ? (
        <ul
          aria-label={heading}
          className="mt-2 divide-y divide-line border-y border-line"
        >
          {queue.items.map((row) => (
            <li key={row.id} className="py-3">
              <Link
                className="break-words font-semibold underline underline-offset-4"
                to={`/app/clients/${client}/tasks/${row.id}`}
              >
                {row.title}
              </Link>
              <p className="mt-1 text-xs leading-5 text-muted">
                {copy(statusLabels[row.status], 'overview')} ·{' '}
                {copy('Priority: {{priority}} · Due', 'overview', {
                  priority: statusLabel(row.priority),
                })}{' '}
                <time dateTime={row.due_at}>{formatTime(row.due_at)}</time>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      )}
      {queue.has_more ? (
        <Link
          className="mt-3 inline-block text-xs underline underline-offset-4"
          to={`/app/clients/${client}/tasks`}
        >
          {copy('More {{value1}} available · Open tasks', 'overview', {
            value1: heading.toLowerCase(),
          })}
        </Link>
      ) : null}
    </div>
  )
}
export function ReminderQueue({
  heading,
  queue,
  client,
  empty,
}: {
  heading: string
  queue: Queue<DueReminder>
  client: string
  empty: string
}) {
  useLocale()
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">{heading}</h3>
      {queue.items.length ? (
        <ul
          aria-label={heading}
          className="mt-2 divide-y divide-line border-y border-line"
        >
          {queue.items.map((row) => (
            <li key={row.id} className="py-3">
              <Link
                className="break-words font-semibold underline underline-offset-4"
                to={`/app/clients/${client}/reminders/${row.id}`}
              >
                {row.title}
              </Link>
              <p className="mt-1 text-xs leading-5 text-muted">
                <time dateTime={row.scheduled_at}>
                  {formatTime(row.scheduled_at, row.timezone)}
                </time>{' '}
                · {row.timezone}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      )}
      {queue.has_more ? (
        <Link
          className="mt-3 inline-block text-xs underline underline-offset-4"
          to={`/app/clients/${client}/reminders`}
        >
          {copy('More {{value1}} available · Open reminders', 'overview', {
            value1: heading.toLowerCase(),
          })}
        </Link>
      ) : null}
    </div>
  )
}
