import { copy, useLocale } from '../../i18n/index'
import { PageSkeleton } from '../../components/ui'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AccessDenied } from '../clients/Shared'
import { useTasks } from './hooks'
import { TaskHeader, TaskError } from './Shared'
import { TaskForm } from './TaskForm'
import * as api from './service'

export function TaskEditorPage({ create = false }: { create?: boolean }) {
  useLocale()
  const { id = '', taskID = '' } = useParams()
  return (
    <TaskEditor
      key={id + ':' + taskID + ':' + create}
      clientID={id}
      taskID={taskID}
      create={create}
    />
  )
}
function TaskEditor({
  clientID,
  taskID,
  create,
}: {
  clientID: string
  taskID: string
  create: boolean
}) {
  useLocale()
  const operation = useTasks(clientID),
    [unavailable, setUnavailable] = useState('')
  const allowed = create
    ? operation.permissions.create
    : operation.permissions.update
  const query = useQuery({
    queryKey: [...operation.key, 'detail', taskID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, taskID, signal)),
    enabled: allowed && !create,
  })
  if (!allowed) return <AccessDenied />
  const blocked =
    unavailable ||
    (query.data?.archived_at
      ? copy('This task is archived. Its history is retained.', 'tasks')
      : ['done', 'cancelled'].includes(query.data?.status ?? '')
        ? copy('Reopen this task before editing its metadata.', 'tasks')
        : '')
  return (
    <section>
      <TaskHeader
        title={
          create ? copy('Create task', 'tasks') : copy('Edit task', 'tasks')
        }
        clientID={clientID}
        operation={operation}
      />
      {!operation.writable ? (
        <p className="mb-4" role="status">
          {copy(
            'Task changes are unavailable while the client is archived or its current state is being checked.',
            'tasks',
          )}
        </p>
      ) : null}
      {!create && query.isPending ? (
        <PageSkeleton label={copy('Loading task…', 'tasks')} />
      ) : !create && query.isError ? (
        <TaskError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : blocked ? (
        <div>
          <p role="status">{blocked}</p>
          <Link
            className="mt-3 inline-block underline underline-offset-4"
            to={`/app/clients/${clientID}/tasks/${taskID}`}
          >
            {copy('Open task', 'tasks')}
          </Link>
        </div>
      ) : create ? (
        <TaskForm
          clientID={clientID}
          operation={operation}
          onUnavailable={setUnavailable}
        />
      ) : query.data ? (
        <TaskForm
          key={taskID}
          clientID={clientID}
          task={query.data}
          operation={operation}
          onUnavailable={setUnavailable}
        />
      ) : null}
    </section>
  )
}
