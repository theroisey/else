import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  const { id = '', taskID = '' } = useParams()
  return <TaskDetail key={id + ':' + taskID} clientID={id} taskID={taskID} />
}
function TaskDetail({
  clientID,
  taskID,
}: {
  clientID: string
  taskID: string
}) {
  useLocale()
  const operation = useTasks(clientID),
    now = useDueClock(),
    location = useLocation()
  const [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: [...operation.key, 'detail', taskID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, taskID, signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  if (query.isPending)
    return <PageSkeleton label={copy('Loading task…', 'tasks')} />
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
        <Button
          disabled={query.isFetching || operation.pending}
          onClick={refresh}
        >
          {copy('Refresh task', 'tasks')}
        </Button>
      </TaskHeader>
      {notice || location.state?.taskSaved ? (
        <p className="mb-4" role="status">
          {notice ||
            (location.state.taskSaved === 'created'
              ? copy('Task created.', 'tasks')
              : copy('Task updated.', 'tasks'))}
        </p>
      ) : null}
      {copy(operation.error, 'tasks') && !confirm ? (
        <div className="mb-4">
          <p role="alert" className="text-danger-ink">
            {copy(operation.error, 'tasks')}
          </p>
          <Button className="mt-2" onClick={refresh}>
            {copy('Reload current task', 'tasks')}
          </Button>
        </div>
      ) : null}
      <div className="mb-5">
        <TaskState task={task} />
      </div>
      {task.archived_at ? (
        <p className="mb-4 text-sm text-muted">
          {copy(
            'Archived {{value1}}. Task details and history are retained.',
            'tasks',
            { value1: formatTime(task.archived_at) },
          )}
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="workspace-section">
          <h2 className="font-semibold">{copy('Description', 'tasks')}</h2>
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">
            {task.description || copy('No description provided.', 'tasks')}
          </p>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">
                {copy('Priority', 'tasks')}
              </dt>
              <dd className="mt-1 capitalize">{statusLabel(task.priority)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{copy('Tags', 'tasks')}</dt>
              <dd className="mt-1 break-words">
                {task.tags.join(', ') || copy('No tags', 'tasks')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{copy('Start', 'tasks')}</dt>
              <dd className="mt-1 text-sm">
                {task.start_at ? (
                  <time dateTime={task.start_at}>
                    {formatTime(task.start_at)}
                  </time>
                ) : (
                  copy('Not scheduled', 'tasks')
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{copy('Due', 'tasks')}</dt>
              <dd className="mt-1 text-sm">
                <TaskDue task={task} now={now} />
              </dd>
            </div>
            {task.completed_at ? (
              <div>
                <dt className="text-xs text-muted">
                  {copy('Completed', 'tasks')}
                </dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={task.completed_at}>
                    {formatTime(task.completed_at)}
                  </time>
                </dd>
              </div>
            ) : null}
            {task.cancelled_at ? (
              <div>
                <dt className="text-xs text-muted">
                  {copy('Cancelled', 'tasks')}
                </dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={task.cancelled_at}>
                    {formatTime(task.cancelled_at)}
                  </time>
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
        <aside className="context-rail">
          <h2 className="font-semibold">{copy('Record context', 'tasks')}</h2>
          <dl className="mt-4 grid gap-4">
            {[
              [copy('Task ID', 'tasks'), task.id],
              [copy('Client ID', 'tasks'), clientID],
              [
                copy('Assignee', 'tasks'),
                task.assignee_id === operation.auth.session?.user.id
                  ? copy('Me', 'tasks')
                  : (task.assignee_id ?? copy('Unassigned', 'tasks')),
              ],
              [
                copy('Creator', 'tasks'),
                task.created_by === operation.auth.session?.user.id
                  ? copy('Me', 'tasks')
                  : task.created_by,
              ],
              [copy('Updated', 'tasks'), formatTime(task.updated_at)],
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
