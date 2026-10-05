import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useDueClock, useTasks } from './hooks'
import { defaultFilter } from './models'
import type { Filter, Summary } from './models'
import { TaskDue, TaskError, TaskHeader, TaskState } from './Shared'
import { TaskActions, TaskArchive } from './TaskActions'
import { TaskFilters } from './TaskFilters'
import * as api from './service'

export function TaskListPage() {
  useLocale()
  const { id = '' } = useParams()
  return <TaskList key={id} clientID={id} />
}
function TaskList({ clientID }: { clientID: string }) {
  useLocale()
  const operation = useTasks(clientID),
    now = useDueClock()
  const [draft, setDraft] = useState<Filter>(defaultFilter),
    [filter, setFilter] = useState<Filter>(defaultFilter),
    [history, setHistory] = useState([''])
  const [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const location = useLocation(),
    cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'list', filter, cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.list(clientID, filter, cursor, signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  const refresh = () => {
    operation.clearError()
    setNotice('')
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  const busy = query.isFetching || operation.pending
  return (
    <section>
      <TaskHeader
        title={copy('Tasks', 'tasks')}
        clientID={clientID}
        operation={operation}
      >
        <Button icon={faRotateRight} disabled={busy} onClick={refresh}>
          {copy('Refresh tasks', 'tasks')}
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={`/app/clients/${clientID}/tasks/new`}
          >
            {copy('Create task', 'tasks')}
          </Link>
        ) : null}
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
            {copy('Reload current tasks', 'tasks')}
          </Button>
        </div>
      ) : null}
      <TaskFilters
        draft={draft}
        setDraft={setDraft}
        actor={operation.auth.session!.user.id}
        onApply={(e) => {
          e.preventDefault()
          setHistory([''])
          setNotice('')
          setFilter({
            ...draft,
            q: draft.q.trim(),
            tag: draft.tag.trim().toLowerCase(),
          })
          operation.clearError()
        }}
      />
      {query.isPending ? (
        <PageSkeleton label={copy('Loading tasks…', 'tasks')} />
      ) : query.isError ? (
        <TaskError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No tasks on this page', 'tasks')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Adjust the filters or create a task if you have access.',
              'tasks',
            )}
          </p>
        </div>
      ) : (
        <Table caption={copy('Client tasks', 'tasks')}>
          <thead>
            <tr>
              {[
                copy('Task', 'tasks'),
                copy('State', 'tasks'),
                copy('Priority', 'tasks'),
                copy('Due', 'tasks'),
                copy('Assignee', 'tasks'),
                copy('Actions', 'tasks'),
              ].map((s) => (
                <th key={s} scope="col">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((task) => (
              <tr key={task.id}>
                <td className="min-w-48 max-w-80">
                  <Link
                    className="break-words font-semibold underline underline-offset-4"
                    aria-label={copy('Open {{value1}}', 'tasks', {
                      value1: task.title,
                    })}
                    to={`/app/clients/${clientID}/tasks/${task.id}`}
                  >
                    {task.title}
                  </Link>
                  <p className="mt-1 break-words text-xs text-muted">
                    {task.tags.join(' · ') || copy('No tags', 'tasks')}
                  </p>
                </td>
                <td>
                  <TaskState task={task} />
                </td>
                <td className="capitalize">{statusLabel(task.priority)}</td>
                <td className="min-w-40 text-xs">
                  <TaskDue task={task} now={now} />
                </td>
                <td className="text-xs">
                  {task.assignee_id === operation.auth.session?.user.id
                    ? copy('Me', 'tasks')
                    : task.assignee_id
                      ? copy('Assigned · {{id}}', 'tasks', {
                          id: task.assignee_id.slice(0, 8),
                        })
                      : copy('Unassigned', 'tasks')}
                </td>
                <td>
                  {!busy ? (
                    <TaskActions
                      key={task.id + ':' + task.revision}
                      task={task}
                      operation={operation}
                      onArchive={setConfirm}
                      onSuccess={setNotice}
                    />
                  ) : (
                    <span className="text-xs text-muted">
                      {copy('Updating…', 'tasks')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <nav
        aria-label={copy('Task pagination', 'tasks')}
        className="mt-4 flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-xs text-muted">
          {copy('Up to 25 tasks per page · Only this client’s tasks', 'tasks')}
        </p>
        <div className="flex gap-2">
          <Button
            size="compact"
            disabled={history.length < 2 || busy}
            onClick={() => setHistory((h) => h.slice(0, -1))}
          >
            {copy('Previous', 'tasks')}
          </Button>
          <Button
            size="compact"
            disabled={query.isError || !query.data?.page.next_cursor || busy}
            onClick={() => {
              if (query.data?.page.next_cursor)
                setHistory((h) => [...h, query.data.page.next_cursor!])
            }}
          >
            {copy('Next', 'tasks')}
          </Button>
        </div>
      </nav>
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
