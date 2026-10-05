import { formatPreciseTime } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import type { ReactNode } from 'react'
import { Button, Status } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import type { useReminders } from './hooks'
import type { Summary } from './models'
import { labels } from './models'
import { offsetLabel } from './time'
export { Pager } from '../planning/Shared'
export type Operation = ReturnType<typeof useReminders>
export function ReminderError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useLocale()
  return (
    <div className="mb-4">
      <p role="alert" className="text-danger-ink">
        {error instanceof APIError
          ? copy(error.message, 'reminders')
          : copy('Unable to load reminders. Try again.', 'reminders')}
      </p>
      <Button className="mt-2" onClick={retry}>
        {copy('Try again', 'reminders')}
      </Button>
    </div>
  )
}
export function ReminderHeader({
  title,
  operation,
  children,
}: {
  title: string
  operation: Operation
  children?: ReactNode
}) {
  useLocale()
  const { clientID, permissions, client } = operation,
    context =
      permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('{{value1}} · Reminders', 'reminders', {
              value1: context?.name ?? copy('Client workspace', 'common'),
            })}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            {copy('One-time schedules · Completion is manual.', 'reminders')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={clientID} />
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          {copy(
            'This client is archived. Reminder history remains available; changes are unavailable.',
            'reminders',
          )}
        </p>
      ) : null}
      {permissions.clientView && client.isError ? (
        <ReminderError
          error={client.error}
          retry={() => {
            void client.refetch()
          }}
        />
      ) : null}
    </>
  )
}
export function ReminderState({ record }: { record: Summary }) {
  useLocale()
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status tone={record.status === 'completed' ? 'success' : 'neutral'}>
        {copy(labels[record.status], 'reminders')}
      </Status>
      {record.is_due ? (
        <Status tone="warning">{copy('Due', 'reminders')}</Status>
      ) : null}
    </div>
  )
}
export function ReminderTime({ record }: { record: Summary }) {
  useLocale()
  return (
    <div>
      <time dateTime={record.scheduled_at}>
        {formatPreciseTime(record.scheduled_at, record.timezone)}
      </time>
      <p className="mt-1 text-xs text-muted">
        {record.timezone} · {offsetLabel(record.utc_offset_seconds)}
      </p>
    </div>
  )
}
