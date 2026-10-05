import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import type { ReactNode } from 'react'
import { Button, Status } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import type { Summary } from './models'
import { statusLabels } from './models'
import { deviceTimezone, dueState, formatTime } from './time'
import type { useTasks } from './hooks'

export function TaskHeader({
  clientID,
  title,
  operation,
  children,
}: {
  clientID: string
  title: string
  operation: ReturnType<typeof useTasks>
  children?: ReactNode
}) {
  useLocale()
  const parent =
    operation.permissions.clientView && !operation.parent.isError
      ? operation.parent.data
      : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {parent?.name ?? copy('Client workspace', 'tasks')}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Times shown in {{value1}} · Due soon means the next 24 hours.',
              'tasks',
              { value1: deviceTimezone() },
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={clientID} />
      {parent?.status === 'archived' ? (
        <p className="mb-4 rounded-md border border-line bg-surface-subtle p-3 text-sm">
          {copy(
            'This client is archived. Task history remains available; changes are unavailable.',
            'tasks',
          )}
        </p>
      ) : null}
      {operation.permissions.clientView && operation.parent.isError ? (
        <TaskError
          error={operation.parent.error}
          retry={() => {
            void operation.parent.refetch()
          }}
        />
      ) : null}
    </>
  )
}
export function TaskError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useLocale()
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? copy(error.message, 'tasks')
          : copy('Unable to load current task data. Try again.', 'tasks')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'tasks')}
      </Button>
    </div>
  )
}
export function TaskState({ task }: { task: Summary }) {
  useLocale()
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status
        tone={
          task.status === 'done'
            ? 'success'
            : task.status === 'blocked'
              ? 'warning'
              : 'neutral'
        }
      >
        {copy(statusLabels[task.status], 'tasks')}
      </Status>
      {task.archived_at ? <Status>{copy('Archived', 'tasks')}</Status> : null}
    </div>
  )
}
export function TaskDue({ task, now }: { task: Summary; now: number }) {
  useLocale()
  const state = dueState(task, now)
  return (
    <div className="grid gap-1">
      {task.due_at ? (
        <time dateTime={task.due_at}>{formatTime(task.due_at)}</time>
      ) : (
        <span className="text-muted">{copy('No due date', 'tasks')}</span>
      )}
      {state ? (
        <Status tone={state === 'Overdue' ? 'danger' : 'warning'}>
          {copy(state, 'tasks')}
        </Status>
      ) : null}
    </div>
  )
}
