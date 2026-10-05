import { useQuery } from '@tanstack/react-query'
import { Button, Dialog, Table } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { differences, markerValue, snapshotState } from './models'
import type { Summary } from './models'
import { auditPermissions } from './permissions'
import * as service from './service'

export function AuditDetail({
  scope,
  row,
  operation,
  onClose,
}: {
  scope: string | undefined
  row: Summary
  operation: ReturnType<typeof useRecordOperations>
  onClose: () => void
}) {
  const permissions = auditPermissions(
    operation.auth.session?.user.permissions ?? [],
    scope,
  )
  const query = useQuery({
    queryKey: [...operation.key, 'detail', row.id],
    queryFn: ({ signal }) =>
      operation.read(() => service.inspect(scope, row, signal)),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  const detail =
    !query.isFetching &&
    !query.isError &&
    query.data &&
    permissions.allows(query.data)
      ? query.data
      : undefined
  const changes = detail
    ? differences(detail.before_state, detail.after_state)
    : []
  return (
    <Dialog
      variant="drawer"
      open
      eyebrow="Audit inspection"
      title="Audit event details"
      description="Recorded safe markers. History is read only."
      onClose={onClose}
    >
      <Button onClick={onClose}>Close details</Button>
      {query.isPending || query.isFetching ? (
        <p role="status">Loading audit details…</p>
      ) : query.isError || !detail ? (
        <div>
          <p role="alert">
            {query.error instanceof APIError
              ? query.error.message
              : 'Unable to load audit details. Try again.'}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              void query.refetch()
            }}
          >
            Retry details
          </Button>
        </div>
      ) : (
        <div className="min-w-0 space-y-5">
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            {Object.entries({
              Event: detail.event_type,
              'Event ID': detail.id,
              'Occurred at (UTC)': detail.occurred_at,
              Actor: detail.actor_user_id ?? 'System',
              'Actor kind': detail.actor_kind,
              Client: detail.client_id ?? 'Global',
              'Resource kind': detail.resource_kind,
              Resource: detail.resource_id,
              'Request ID': detail.request_id,
              'Schema version': String(detail.schema_version),
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="mt-1 break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <section>
            <h3 className="mb-3 font-semibold">Safe field differences</h3>
            <p className="mb-3 text-xs text-muted">
              Before snapshot: {snapshotState(detail.before_state)} · After
              snapshot: {snapshotState(detail.after_state)}
            </p>
            {changes.length ? (
              <Table caption="Safe field differences">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr key={change.key}>
                      <th scope="row">{change.label}</th>
                      <td className="break-all font-mono text-xs">
                        {markerValue(change.before, change.key)}
                      </td>
                      <td className="break-all font-mono text-xs">
                        {markerValue(change.after, change.key)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p>No marker differences recorded.</p>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              Raw safe snapshots and metadata
            </summary>
            <pre className="mt-3 whitespace-pre-wrap break-all rounded-sm border border-line bg-surface-subtle p-3 text-xs">
              {JSON.stringify(
                {
                  before_state: detail.before_state,
                  after_state: detail.after_state,
                  metadata: detail.metadata,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
    </Dialog>
  )
}
