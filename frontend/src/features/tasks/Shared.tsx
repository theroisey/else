import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, Status, buttonStyles } from '../../components/ui'
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
  const parent =
    operation.permissions.clientView && !operation.parent.isError
      ? operation.parent.data
      : undefined
  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{parent?.name ?? 'Client workspace'}</p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            Times shown in {deviceTimezone()} · Due soon means the next 24 hours.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        {parent ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}`}>
            Overview
          </Link>
        ) : null}
        <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/tasks`}>
          Tasks
        </Link>
        {operation.permissions.planningView ? <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/plans`}>Planning</Link> : null}
      </nav>
      {parent?.status === 'archived' ? (
        <p className="mb-4 rounded-md border border-line bg-surface-subtle p-3 text-sm">
          This client is archived. Task history remains available; changes are unavailable.
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
export function TaskError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError ? error.message : 'Unable to load current task data. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
export function TaskState({ task }: { task: Summary }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status
        tone={
          task.status === 'done' ? 'success' : task.status === 'blocked' ? 'warning' : 'neutral'
        }
      >
        {statusLabels[task.status]}
      </Status>
      {task.archived_at ? <Status>Archived</Status> : null}
    </div>
  )
}
export function TaskDue({ task, now }: { task: Summary; now: number }) {
  const state = dueState(task, now)
  return (
    <div className="grid gap-1">
      {task.due_at ? (
        <time dateTime={task.due_at}>{formatTime(task.due_at)}</time>
      ) : (
        <span className="text-muted">No due date</span>
      )}
      {state ? <Status tone={state === 'Overdue' ? 'danger' : 'warning'}>{state}</Status> : null}
    </div>
  )
}
