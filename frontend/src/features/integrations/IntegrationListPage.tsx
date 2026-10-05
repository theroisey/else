import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, PageSkeleton } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { Pager } from '../planning/Shared'
import { useIntegrations, useIntegrationClient } from './hooks'
import type { Operation } from './hooks'
import { IntegrationError, IntegrationHeader, IntegrationState } from './Shared'
import * as service from './service'
import { providerLabels } from './models'
import { GA4CreateForm } from '../analytics/GA4CreateForm'
import { WooCommerceCreateForm } from '../ecommerce/WooCommerceCreateForm'
import { MetaCreateForm } from '../marketing/MetaCreateForm'
import { formatTime } from '../../lib/time'

export function IntegrationListPage() {
  useLocale()
  const clientID = useParams().id ?? ''
  const operation = useIntegrations(clientID)
  if (!isUUID(clientID))
    return (
      <h1 className="page-title">
        {copy('Integrations not found', 'integrations')}
      </h1>
    )
  if (!operation.permissions.view) return <AccessDenied />
  return (
    <Connections key={JSON.stringify(operation.key)} operation={operation} />
  )
}
function Connections({ operation }: { operation: Operation }) {
  useLocale()
  const { clientID } = operation
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const client = useIntegrationClient(operation)
  const query = useQuery({
    queryKey: [...operation.key, 'list', refresh, history.at(-1)],
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) =>
      operation.read(() => service.list(clientID, history.at(-1)!, signal)),
  })
  const busy = query.isFetching || client.isFetching
  const failed = query.isError || client.isError
  const rows = !busy && !failed ? query.data?.data : undefined
  function reload() {
    operation.clearError()
    setHistory([''])
    setRefresh((v) => v + 1)
    void client.refetch()
  }
  return (
    <section className="max-w-5xl">
      <IntegrationHeader
        clientID={clientID}
        name={!busy && !failed ? client.data?.name : undefined}
      />
      <Button disabled={busy || operation.pending} onClick={reload}>
        {copy('Refresh integrations', 'integrations')}
      </Button>
      {!busy &&
      !failed &&
      rows &&
      operation.permissions.manage &&
      client.data?.status === 'active' ? (
        <GA4CreateForm operation={operation} />
      ) : null}
      {!busy &&
      !failed &&
      rows &&
      operation.permissions.manage &&
      client.data?.status === 'active' ? (
        <WooCommerceCreateForm operation={operation} />
      ) : null}
      {!busy &&
      !failed &&
      rows &&
      operation.permissions.manage &&
      client.data?.status === 'active' ? (
        <MetaCreateForm operation={operation} />
      ) : null}
      {!busy && !failed && client.data?.status === 'archived' ? (
        <p role="status" className="mt-4 text-sm text-muted">
          {copy(
            'This client is archived. Connection history remains readable; changes are unavailable.',
            'integrations',
          )}
        </p>
      ) : null}
      {busy || query.isPending || client.isPending ? (
        <PageSkeleton label={copy('Loading integrations…', 'integrations')} />
      ) : failed ? (
        <IntegrationError
          error={query.isError ? query.error : client.error}
          retry={reload}
        />
      ) : rows?.length ? (
        <div className="mt-5">
          <Table caption={copy('Integration connections', 'integrations')}>
            <thead>
              <tr>
                <th>{copy('Provider / Connection', 'integrations')}</th>
                <th>{copy('Recorded state', 'integrations')}</th>
                <th>
                  {copy(
                    'Last metadata change (Europe/Istanbul)',
                    'integrations',
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr key={record.id}>
                  <td>
                    <Link
                      className="font-semibold underline underline-offset-4"
                      to={`/app/clients/${clientID}/integrations/${record.id}`}
                    >
                      <span className="block">
                        {copy(providerLabels[record.provider], 'integrations')}
                      </span>
                      <span className="mt-1 block break-all font-mono text-xs">
                        {record.id}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <IntegrationState record={record} />
                  </td>
                  <td>
                    <time
                      className="break-all font-mono text-xs"
                      dateTime={record.updated_at}
                    >
                      {formatTime(record.updated_at, 'Europe/Istanbul')}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-line bg-surface-subtle p-6">
          <h2 className="font-semibold">
            {copy('No connections on this page', 'integrations')}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'No recorded connections are available with your current access. GA4, WooCommerce and Meta setup are available to authorized integration managers.',
              'integrations',
            )}
          </p>
        </div>
      )}
      <Pager
        name={copy('Integrations', 'integrations')}
        history={history}
        next={!busy && !failed ? query.data?.page.next_cursor : null}
        busy={busy}
        onChange={setHistory}
      />
      <p className="mt-4 text-xs text-muted">
        {copy(
          'Each page checks current access. Refresh returns to the first page.',
          'integrations',
        )}
      </p>
    </section>
  )
}
