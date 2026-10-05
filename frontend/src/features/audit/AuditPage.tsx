import { formatTime } from '../../lib/time'
import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, PageSkeleton } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { useRecordOperations } from '../auth/useRecordOperations'
import { AccessDenied } from '../clients/Shared'
import { Pager } from '../planning/Shared'
import { auditPermissions } from './permissions'
import { emptyFilters } from './models'
import type { Filters, Summary } from './models'
import { AuditFilters } from './AuditFilters'
import { AuditDetail } from './AuditDetail'
import * as service from './service'

export function AuditPage({ client = false }: { client?: boolean }) {
  useLocale()
  const params = useParams()
  const scope = client ? params.id : undefined
  const operation = useRecordOperations('audit', scope)
  const permissions = auditPermissions(
    operation.auth.session?.user.permissions ?? [],
    scope,
  )
  if (client && !isUUID(scope))
    return (
      <section>
        <h1 className="page-title">
          {copy('Audit history not found', 'audit')}
        </h1>
        <p className="mt-3 text-muted">
          {copy('This client address is not valid.', 'audit')}
        </p>
      </section>
    )
  if (!permissions.view) return <AccessDenied />
  return (
    <AuditReader
      key={JSON.stringify(operation.key)}
      scope={scope}
      operation={operation}
      permissions={permissions}
    />
  )
}
function AuditReader({
  scope,
  operation,
  permissions,
}: {
  scope: string | undefined
  operation: ReturnType<typeof useRecordOperations>
  permissions: ReturnType<typeof auditPermissions>
}) {
  useLocale()
  const [filters, setFilters] = useState({ ...emptyFilters })
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<Summary | null>(null)
  const filterAccess =
    !filters.client_id || permissions.clientView(filters.client_id)
  const query = useQuery({
    queryKey: [...operation.key, 'list', filters, refresh, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() =>
        service.list(scope, filters, history.at(-1)!, signal),
      ),
    enabled: filterAccess,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  const rows =
    !query.isError && !query.isFetching && filterAccess
      ? query.data?.data.filter(permissions.allows)
      : undefined
  function reload() {
    setSelected(null)
    setHistory([''])
    setRefresh((v) => v + 1)
  }
  function apply(f: Filters) {
    setSelected(null)
    setFilters(f)
    setHistory([''])
    setRefresh((v) => v + 1)
  }
  return (
    <section className="max-w-7xl">
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('{{value1}} · History', 'audit', {
              value1: copy(scope ? 'Client workspace' : 'Security', 'audit'),
            })}
          </p>
          <h1 className="page-title">{copy('Audit history', 'audit')}</h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'Recorded events, newest first. Exact times are shown in UTC.',
              'audit',
            )}
          </p>
          {scope ? (
            <p className="mt-2 break-all font-mono text-xs text-muted">
              {copy('Client {{value1}}', 'audit', { value1: scope })}
            </p>
          ) : null}
        </div>
        <Button disabled={query.isFetching} onClick={reload}>
          {copy('Refresh audit history', 'audit')}
        </Button>
      </header>
      {scope ? <ClientNavigation clientID={scope!} /> : null}
      <AuditFilters scope={scope} busy={query.isFetching} onApply={apply} />
      {!filterAccess ? (
        <p role="alert">
          {copy(
            'This client is not available with your current access. Clear or change the client filter.',
            'audit',
          )}
        </p>
      ) : query.isPending || query.isFetching ? (
        <PageSkeleton label={copy('Loading audit history…', 'audit')} />
      ) : query.isError ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">
            {query.error instanceof APIError
              ? copy(query.error.message, 'audit')
              : copy('Unable to load audit history. Try again.', 'audit')}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              void query.refetch()
            }}
          >
            {copy('Try again', 'audit')}
          </Button>
        </div>
      ) : rows?.length ? (
        <Table caption={copy('Audit events', 'audit')}>
          <thead>
            <tr>
              <th scope="col">{copy('Event / Time (UTC)', 'audit')}</th>
              <th scope="col">{copy('Actor', 'audit')}</th>
              <th scope="col">{copy('Client', 'audit')}</th>
              <th scope="col">{copy('Resource', 'audit')}</th>
              <th scope="col">{copy('Request / Details', 'audit')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="min-w-52">
                  <span className="block font-semibold">{row.event_type}</span>
                  <time
                    className="mt-1 block font-mono text-xs text-muted"
                    dateTime={row.occurred_at}
                  >
                    {formatTime(row.occurred_at, 'UTC')}
                  </time>
                </th>
                <td className="max-w-48 break-all font-mono text-xs">
                  {row.actor_user_id ?? copy('System', 'audit')}
                </td>
                <td className="max-w-48 break-all font-mono text-xs">
                  {row.client_id ?? copy('Global', 'audit')}
                </td>
                <td className="max-w-48 break-all text-xs">
                  <span className="block">{row.resource_kind}</span>
                  <span className="font-mono">{row.resource_id}</span>
                </td>
                <td>
                  <span className="block break-all font-mono text-xs text-muted">
                    {row.request_id}
                  </span>
                  <Button
                    size="compact"
                    className="mt-2"
                    aria-label={copy(
                      'Inspect {{value1}} event {{value2}}',
                      'audit',
                      { value1: row.event_type, value2: row.id },
                    )}
                    onClick={() => setSelected(row)}
                  >
                    {copy('Inspect event', 'audit')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No audit events on this page', 'audit')}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'No recorded events match these filters and your current access. Change filters or refresh to check for newer events.',
              'audit',
            )}
          </p>
        </div>
      )}
      <Pager
        name={copy('Audit', 'audit')}
        history={history}
        next={
          !query.isError && !query.isFetching && filterAccess
            ? query.data?.page.next_cursor
            : null
        }
        busy={query.isFetching}
        onChange={(next) => {
          setSelected(null)
          setHistory(next)
        }}
      />
      <p className="mt-4 text-xs text-muted">
        {copy(
          'Read only. Each page reflects current access. Refresh returns to the newest events.',
          'audit',
        )}
      </p>
      {selected &&
      rows?.some((row) => row.id === selected.id) &&
      permissions.allows(selected) ? (
        <AuditDetail
          key={selected.id}
          scope={scope}
          row={selected}
          operation={operation}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  )
}
