import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, Status, buttonStyles } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import type { useReminders } from './hooks'
import type { Summary } from './models'
import { labels, pagePath } from './models'
import { offsetLabel } from './time'
export { Pager } from '../planning/Shared'
export type Operation = ReturnType<typeof useReminders>
export function ReminderError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="mb-4">
      <p role="alert" className="text-danger-ink">
        {error instanceof APIError ? error.message : 'Unable to load reminders. Try again.'}
      </p>
      <Button className="mt-2" onClick={retry}>
        Try again
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
  const { clientID, permissions, client } = operation,
    context = permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{context?.name ?? 'Client workspace'} · Reminders</p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-xs text-muted">One-time schedules · Completion is manual.</p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        {context ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}`}>
            Overview
          </Link>
        ) : null}
        {permissions.taskView ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/tasks`}>
            Tasks
          </Link>
        ) : null}
        {permissions.planningView ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/plans`}>
            Planning
          </Link>
        ) : null}
        <Link className={buttonStyles({ size: 'compact' })} to={pagePath(clientID)}>
          Reminders
        </Link>
        {permissions.activityView ? <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/activity`}>Activity</Link> : null}
      </nav>
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          This client is archived. Reminder history remains available; changes are unavailable.
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
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status tone={record.status === 'completed' ? 'success' : 'neutral'}>
        {labels[record.status]}
      </Status>
      {record.is_due ? <Status tone="warning">Due</Status> : null}
    </div>
  )
}
export function ReminderTime({ record }: { record: Summary }) {
  return (
    <div>
      <time dateTime={record.scheduled_at}>{record.scheduled_local.replace('T', ' ')}</time>
      <p className="mt-1 text-xs text-muted">
        {record.timezone} · {offsetLabel(record.utc_offset_seconds)}
      </p>
    </div>
  )
}
