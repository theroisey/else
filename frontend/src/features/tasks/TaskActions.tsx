import { useState } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, buttonStyles } from '../../components/ui'
import { statusLabels, transitions } from './models'
import type { Summary, TaskStatus } from './models'
import type { useTasks } from './hooks'
import * as api from './service'

type Operation = ReturnType<typeof useTasks>
export function TaskActions({
  task,
  operation,
  onArchive,
  onSuccess,
}: {
  task: Summary
  operation: Operation
  onArchive: (task: Summary) => void
  onSuccess: (message: string) => void
}) {
  const [next, setNext] = useState<TaskStatus | ''>('')
  if (task.archived_at || !operation.writable) return null
  const update = operation.permissions.update,
    archive = operation.permissions.archive
  const busy = operation.pending || !!operation.error
  return (
    <div className="flex flex-wrap items-center gap-2">
      {update && !['done', 'cancelled'].includes(task.status) ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={`/app/clients/${task.client_id}/tasks/${task.id}/edit`}
        >
          Edit task
        </Link>
      ) : null}
      {update ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!next || busy) return
            void operation
              .run(() => api.transition(task.client_id, task.id, next, task.revision))
              .then((result) => {
                if (result) {
                  setNext('')
                  onSuccess('Task status updated.')
                }
              })
          }}
        >
          <label className="sr-only" htmlFor={'status-' + task.id}>
            Next status for {task.title}
          </label>
          <select
            id={'status-' + task.id}
            className="ui-input min-w-36 text-xs"
            value={next}
            disabled={busy}
            onChange={(e) => setNext(e.target.value as TaskStatus | '')}
          >
            <option value="">
              {['done', 'cancelled'].includes(task.status) ? 'Reopen as…' : 'Change to…'}
            </option>
            {transitions[task.status].map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
          <Button
            size="compact"
            disabled={!next || busy}
            type="submit"
            aria-label={`Change status of ${task.title}`}
          >
            Apply status
          </Button>
        </form>
      ) : null}
      {archive ? (
        <Button
          size="compact"
          variant="danger"
          disabled={busy}
          aria-label={`Archive ${task.title}`}
          onClick={() => {
            operation.clearError()
            onArchive(task)
          }}
        >
          Archive
        </Button>
      ) : null}
    </div>
  )
}
export function TaskArchive({
  task,
  operation,
  onClose,
  onSuccess,
}: {
  task: Summary
  operation: Operation
  onClose: () => void
  onSuccess: () => void
}) {
  return (
    <Dialog
      open
      title={`Archive ${task.title}?`}
      description="The task, its status and its history will be retained. Further changes will be unavailable."
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {operation.error ? (
        <div>
          <p role="alert" className="text-danger-ink">
            {operation.error}
          </p>
          <p className="mt-2 text-xs text-muted">
            Cancel and refresh before reviewing another attempt.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          loadingLabel="Archiving task"
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() => api.archive(task.client_id, task.id, task.revision))
              .then((result) => {
                if (result) onSuccess()
              })
          }}
        >
          Confirm archive
        </Button>
      </div>
    </Dialog>
  )
}
