import { useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useDueClock, useTasks } from './hooks'
import { TaskDue, TaskError, TaskHeader, TaskState } from './Shared'
import { TaskActions, TaskArchive } from './TaskActions'
import type { Summary } from './models'
import { formatTime } from './time'
import * as api from './service'

export function TaskDetailPage() {
  const { id = '', taskID = '' } = useParams()
  return <TaskDetail key={id + ':' + taskID} clientID={id} taskID={taskID} />
}
function TaskDetail({ clientID, taskID }: { clientID: string; taskID: string }) {
  const operation = useTasks(clientID),
    now = useDueClock(),
    location = useLocation()
  const [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: [...operation.key, 'detail', taskID],
    queryFn: ({ signal }) => operation.read(() => api.detail(clientID, taskID, signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  if (query.isPending)
    return (
      <PageSkeleton label="Loading task…" />
    )
  if (query.isError)
    return (
      <TaskError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const task = query.data
  const refresh = () => {
    operation.clearError()
    setNotice('')
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  return (
    <section>
      <TaskHeader title={task.title} clientID={clientID} operation={operation}>
        <Button disabled={query.isFetching || operation.pending} onClick={refresh}>
          Refresh task
        </Button>
      </TaskHeader>
      {notice || location.state?.taskSaved ? (
        <p className="mb-4" role="status">
          {notice || (location.state.taskSaved === 'created' ? 'Task created.' : 'Task updated.')}
        </p>
      ) : null}
      {operation.error && !confirm ? (
        <div className="mb-4">
          <p role="alert" className="text-danger-ink">
            {operation.error}
          </p>
          <Button className="mt-2" onClick={refresh}>
            Reload current task
          </Button>
        </div>
      ) : null}
      <div className="mb-5">
        <TaskState task={task} />
      </div>
      {task.archived_at ? (
        <p className="mb-4 text-sm text-muted">
          Archived {formatTime(task.archived_at)}. Task details and history are retained.
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="workspace-section">
          <h2 className="font-semibold">Description</h2>
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">
            {task.description || 'No description provided.'}
          </p>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Priority</dt>
              <dd className="mt-1 capitalize">{task.priority}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Tags</dt>
              <dd className="mt-1 break-words">{task.tags.join(', ') || 'No tags'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Start</dt>
              <dd className="mt-1 text-sm">
                {task.start_at ? (
                  <time dateTime={task.start_at}>{formatTime(task.start_at)}</time>
                ) : (
                  'Not scheduled'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Due</dt>
              <dd className="mt-1 text-sm">
                <TaskDue task={task} now={now} />
              </dd>
            </div>
            {task.completed_at ? (
              <div>
                <dt className="text-xs text-muted">Completed</dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={task.completed_at}>{formatTime(task.completed_at)}</time>
                </dd>
              </div>
            ) : null}
            {task.cancelled_at ? (
              <div>
                <dt className="text-xs text-muted">Cancelled</dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={task.cancelled_at}>{formatTime(task.cancelled_at)}</time>
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
        <aside className="context-rail">
          <h2 className="font-semibold">Record context</h2>
          <dl className="mt-4 grid gap-4">
            {[
              ['Task ID', task.id],
              ['Client ID', clientID],
              [
                'Assignee',
                task.assignee_id === operation.auth.session?.user.id
                  ? 'Me'
                  : (task.assignee_id ?? 'Unassigned'),
              ],
              [
                'Creator',
                task.created_by === operation.auth.session?.user.id ? 'Me' : task.created_by,
              ],
              ['Updated', formatTime(task.updated_at)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 break-all text-xs">{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
      {!query.isFetching ? (
        <div className="mt-5">
          <TaskActions
            key={task.id + ':' + task.revision}
            task={task}
            operation={operation}
            onArchive={setConfirm}
            onSuccess={setNotice}
          />
        </div>
      ) : null}
      {confirm && operation.permissions.archive && operation.writable ? (
        <TaskArchive
          task={confirm}
          operation={operation}
          onClose={() => setConfirm(null)}
          onSuccess={() => {
            setConfirm(null)
            setNotice('Task archived.')
          }}
        />
      ) : null}
    </section>
  )
}
