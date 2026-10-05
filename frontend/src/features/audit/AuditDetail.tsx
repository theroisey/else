import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
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
      eyebrow={copy('Audit inspection', 'audit')}
      title={copy('Audit event details', 'audit')}
      description={copy(
        'Recorded safe markers. History is read only.',
        'audit',
      )}
      onClose={onClose}
    >
      <Button onClick={onClose}>{copy('Close details', 'audit')}</Button>
      {query.isPending || query.isFetching ? (
        <p role="status">{copy('Loading audit details…', 'audit')}</p>
      ) : query.isError || !detail ? (
        <div>
          <p role="alert">
            {query.error instanceof APIError
              ? copy(query.error.message, 'audit')
              : copy('Unable to load audit details. Try again.', 'audit')}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              void query.refetch()
            }}
          >
            {copy('Retry details', 'audit')}
          </Button>
        </div>
      ) : (
        <div className="min-w-0 space-y-5">
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            {Object.entries({
              Event: detail.event_type,
              'Event ID': detail.id,
              'Occurred at (UTC)': detail.occurred_at,
              Actor: detail.actor_user_id ?? copy('System', 'audit'),
              'Actor kind': detail.actor_kind,
              Client: detail.client_id ?? copy('Global', 'audit'),
              'Resource kind': detail.resource_kind,
              Resource: detail.resource_id,
              'Request ID': detail.request_id,
              'Schema version': String(detail.schema_version),
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{copy(label, 'audit')}</dt>
                <dd className="mt-1 break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <section>
            <h3 className="mb-3 font-semibold">
              {copy('Safe field differences', 'audit')}
            </h3>
            <p className="mb-3 text-xs text-muted">
              {copy(
                'Before snapshot: {{value1}} · After snapshot: {{value2}}',
                'audit',
                {
                  value1: snapshotState(detail.before_state),
                  value2: snapshotState(detail.after_state),
                },
              )}
            </p>
            {changes.length ? (
              <Table caption={copy('Safe field differences', 'audit')}>
                <thead>
                  <tr>
                    <th scope="col">{copy('Field', 'audit')}</th>
                    <th scope="col">{copy('Before', 'audit')}</th>
                    <th scope="col">{copy('After', 'audit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr key={change.key}>
                      <th scope="row">{copy(change.label, 'audit')}</th>
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
              <p>{copy('No marker differences recorded.', 'audit')}</p>
            )}
          </section>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">
              {copy('Raw safe snapshots and metadata', 'audit')}
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
