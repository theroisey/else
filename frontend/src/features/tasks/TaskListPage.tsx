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
  const { id = '' } = useParams()
  return <TaskList key={id} clientID={id} />
}
function TaskList({ clientID }: { clientID: string }) {
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
    queryFn: ({ signal }) => operation.read(() => api.list(clientID, filter, cursor, signal)),
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
      <TaskHeader title="Tasks" clientID={clientID} operation={operation}>
        <Button icon={faRotateRight} disabled={busy} onClick={refresh}>
          Refresh tasks
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={`/app/clients/${clientID}/tasks/new`}
          >
            Create task
          </Link>
        ) : null}
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
            Reload current tasks
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
        <PageSkeleton label="Loading tasks…" />
      ) : query.isError ? (
        <TaskError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">No tasks on this page</h2>
          <p className="mt-2 text-muted">Adjust the filters or create a task if you have access.</p>
        </div>
      ) : (
        <Table caption="Client tasks">
          <thead>
            <tr>
              {['Task', 'State', 'Priority', 'Due', 'Assignee', 'Actions'].map((s) => (
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
                    aria-label={`Open ${task.title}`}
                    to={`/app/clients/${clientID}/tasks/${task.id}`}
                  >
                    {task.title}
                  </Link>
                  <p className="mt-1 break-words text-xs text-muted">
                    {task.tags.join(' · ') || 'No tags'}
                  </p>
                </td>
                <td>
                  <TaskState task={task} />
                </td>
                <td className="capitalize">{task.priority}</td>
                <td className="min-w-40 text-xs">
                  <TaskDue task={task} now={now} />
                </td>
                <td className="text-xs">
                  {task.assignee_id === operation.auth.session?.user.id
                    ? 'Me'
                    : task.assignee_id
                      ? 'Assigned · ' + task.assignee_id.slice(0, 8)
                      : 'Unassigned'}
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
                    <span className="text-xs text-muted">Updating…</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <nav
        aria-label="Task pagination"
        className="mt-4 flex flex-wrap items-center justify-between gap-3"
      >
        <p className="text-xs text-muted">Up to 25 tasks per page · Only this client’s tasks</p>
        <div className="flex gap-2">
          <Button
            size="compact"
            disabled={history.length < 2 || busy}
            onClick={() => setHistory((h) => h.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="compact"
            disabled={query.isError || !query.data?.page.next_cursor || busy}
            onClick={() => {
              if (query.data?.page.next_cursor)
                setHistory((h) => [...h, query.data.page.next_cursor!])
            }}
          >
            Next
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
