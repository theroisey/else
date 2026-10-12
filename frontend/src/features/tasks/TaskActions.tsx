import { copy, useLocale } from '../../i18n/index'
import { hasPermission } from '../auth/permissions'
import { AssigneePicker } from './AssigneePicker'
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
  useLocale()
  const [next, setNext] = useState<TaskStatus | ''>('')
  const [assigning, setAssigning] = useState(false)
  if (task.archived_at || !operation.writable) return null
  const update = operation.permissions.update,
    archive = operation.permissions.archive
  const statusUpdate =
    update ||
    (operation.permissions.updateOwn &&
      task.assignee_id === operation.auth.session?.user.id)
  const busy = operation.pending || !!operation.error
  if (task.request_id)
    return (
      <p className="text-sm text-muted">
        {copy(
          'Status and assignment are managed through the technical request.',
          'operations',
        )}{' '}
        {hasPermission(operation.auth.session?.user.permissions ?? [], {
          permission: 'tickets.read_all',
          scope: 'client',
          clientID: task.client_id,
        }) ? (
          <Link
            className="underline underline-offset-4"
            to={`/app/clients/${task.client_id}/requests/${task.request_id}`}
          >
            {copy('Open technical request', 'operations')}
          </Link>
        ) : null}
      </p>
    )
  return (
    <div className="record-actions flex flex-wrap items-center gap-2">
      {update && !['done', 'cancelled'].includes(task.status) ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={`/app/clients/${task.client_id}/tasks/${task.id}/edit`}
        >
          {copy('Edit task', 'tasks')}
        </Link>
      ) : null}
      {statusUpdate ? (
        <form
          className="inline-flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!next || busy) return
            void operation
              .run(() =>
                api.transition(task.client_id, task.id, next, task.revision),
              )
              .then((result) => {
                if (result) {
                  setNext('')
                  onSuccess('Task status updated.')
                }
              })
          }}
        >
          <label className="sr-only" htmlFor={'status-' + task.id}>
            {copy('Next status for {{value1}}', 'tasks', {
              value1: task.title,
            })}
          </label>
          <select
            id={'status-' + task.id}
            className="ui-input min-h-8 w-32 min-w-28 py-1 text-xs"
            value={next}
            disabled={busy}
            onChange={(e) => setNext(e.target.value as TaskStatus | '')}
          >
            <option value="">
              {['done', 'cancelled'].includes(task.status)
                ? copy('Reopen as…', 'tasks')
                : copy('Change to…', 'tasks')}
            </option>
            {transitions[task.status].map((s) => (
              <option key={s} value={s}>
                {copy(statusLabels[s], 'tasks')}
              </option>
            ))}
          </select>
          <Button
            size="compact"
            disabled={!next || busy}
            type="submit"
            aria-label={copy('Change status of {{value1}}', 'tasks', {
              value1: task.title,
            })}
          >
            {copy('Apply status', 'tasks')}
          </Button>
        </form>
      ) : null}
      {operation.permissions.assignTeam &&
      !['done', 'cancelled'].includes(task.status) ? (
        <Button
          size="compact"
          disabled={busy}
          onClick={() => setAssigning(true)}
        >
          {copy('Reassign task', 'operations')}
        </Button>
      ) : null}
      {assigning ? (
        <TaskAssignment
          task={task}
          operation={operation}
          close={() => setAssigning(false)}
          onSuccess={onSuccess}
        />
      ) : null}
      {archive ? (
        <Button
          size="compact"
          variant="danger-ghost"
          disabled={busy}
          aria-label={copy('Archive {{value1}}', 'tasks', {
            value1: task.title,
          })}
          onClick={() => {
            operation.clearError()
            onArchive(task)
          }}
        >
          {copy('Archive', 'tasks')}
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
  useLocale()
  return (
    <Dialog
      open
      title={copy('Archive {{value1}}?', 'tasks', { value1: task.title })}
      description={copy(
        'The task, its status and its history will be retained. Further changes will be unavailable.',
        'tasks',
      )}
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {copy(operation.error, 'tasks') ? (
        <div>
          <p role="alert" className="text-danger-ink">
            {copy(operation.error, 'tasks')}
          </p>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Cancel and refresh before reviewing another attempt.',
              'tasks',
            )}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          {copy('Cancel', 'tasks')}
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          loadingLabel={copy('Archiving task', 'tasks')}
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() => api.archive(task.client_id, task.id, task.revision))
              .then((result) => {
                if (result) onSuccess()
              })
          }}
        >
          {copy('Confirm archive', 'tasks')}
        </Button>
      </div>
    </Dialog>
  )
}

function TaskAssignment({
  task,
  operation,
  close,
  onSuccess,
}: {
  task: Summary
  operation: Operation
  close: () => void
  onSuccess: (v: string) => void
}) {
  const [baseline] = useState(task)
  const [value, setValue] = useState(task.assignee_id ?? '')
  return (
    <Dialog
      open
      variant="drawer"
      title={copy('Reassign task', 'operations')}
      description={copy(
        'Assignments are limited to your authorized team and brand.',
        'operations',
      )}
      onClose={() => {
        if (!operation.pending) close()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void operation
            .run(() =>
              api.assign(
                task.client_id,
                task.id,
                value || null,
                baseline.revision,
              ),
            )
            .then((r) => {
              if (r) {
                onSuccess(copy('Task reassigned.', 'operations'))
                close()
              }
            })
        }}
      >
        <AssigneePicker
          clientID={task.client_id}
          operation={operation}
          value={value}
          onChange={setValue}
          disabled={operation.pending}
          error={operation.error}
        />
        <Button
          type="submit"
          className="mt-5"
          variant="primary"
          disabled={operation.pending}
        >
          {copy('Save', 'operations')}
        </Button>
      </form>
    </Dialog>
  )
}
