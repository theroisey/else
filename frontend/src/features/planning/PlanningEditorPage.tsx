import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AccessDenied } from '../clients/Shared'
import { usePlanning } from './hooks'
import { recordKey } from './models'
import type { Scope } from './models'
import { PlanningHeader, PlanningError } from './Shared'
import { PlanningForm } from './PlanningForm'
import * as api from './service'
export function PlanningEditorPage({
  milestone = false,
  create = false,
}: {
  milestone?: boolean
  create?: boolean
}) {
  const { id = '', planID = '', milestoneID = '' } = useParams()
  const scope: Scope = { clientID: id, ...(milestone ? { planID } : {}) },
    recordID = milestone ? milestoneID : planID
  return (
    <PlanningEditor
      key={id + ':' + planID + ':' + milestoneID + ':' + create}
      scope={scope}
      recordID={recordID}
      create={create}
    />
  )
}
function PlanningEditor({
  scope,
  recordID,
  create,
}: {
  scope: Scope
  recordID: string
  create: boolean
}) {
  const operation = usePlanning(scope)
  const allowed = create ? operation.permissions.create : operation.permissions.update
  const query = useQuery({
    queryKey: [...operation.key, ...recordKey(scope, recordID)],
    queryFn: ({ signal }) => operation.read(() => api.detail(scope, recordID, signal)),
    enabled: allowed && !create,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === operation.auth.session?.user.id ? previous : undefined,
  })
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <PlanningHeader
        title={(create ? 'Create ' : 'Edit ') + (scope.planID ? 'milestone' : 'plan')}
        operation={operation}
      />
      {!create && query.isPending ? (
        <p role="status" aria-busy="true">
          Loading record…
        </p>
      ) : !create && query.isError && !query.data ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : create ? (
        <PlanningForm operation={operation} />
      ) : query.data ? (
        <>
          {query.isError ? (
            <PlanningError
              error={query.error}
              retry={() => {
                void query.refetch()
              }}
            />
          ) : null}
          <PlanningForm
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
