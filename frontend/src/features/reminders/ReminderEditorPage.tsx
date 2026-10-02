import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AccessDenied } from '../clients/Shared'
import { useReminders } from './hooks'
import { ReminderError, ReminderHeader } from './Shared'
import { ReminderForm } from './ReminderForm'
import * as api from './service'
export function ReminderEditorPage({ create = false }: { create?: boolean }) {
  const { id = '', reminderID = '' } = useParams()
  return (
    <Editor
      key={id + ':' + reminderID + ':' + create}
      clientID={id}
      recordID={reminderID}
      create={create}
    />
  )
}
function Editor({
  clientID,
  recordID,
  create,
}: {
  clientID: string
  recordID: string
  create: boolean
}) {
  const operation = useReminders(clientID),
    allowed = create ? operation.permissions.create : operation.permissions.update
  const query = useQuery({
    queryKey: [...operation.key, 'detail', recordID],
    queryFn: ({ signal }) => operation.read(() => api.detail(clientID, recordID, signal)),
    enabled: allowed && !create,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === operation.auth.session?.user.id ? previous : undefined,
  })
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <ReminderHeader title={create ? 'Create reminder' : 'Edit reminder'} operation={operation} />
      {!create && query.isPending ? (
        <p role="status" aria-busy="true">
          Loading reminder…
        </p>
      ) : !create && query.isError && !query.data ? (
        <ReminderError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : create ? (
        <ReminderForm operation={operation} />
      ) : query.data ? (
        <>
          {query.isError ? (
            <ReminderError
              error={query.error}
              retry={() => {
                void query.refetch()
              }}
            />
          ) : null}
          <ReminderForm
            key={recordID}
            record={query.data}
            operation={operation}
            checking={query.isError || query.isFetching}
          />
        </>
      ) : null}
    </section>
  )
}
