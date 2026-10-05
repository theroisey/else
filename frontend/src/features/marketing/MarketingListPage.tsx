import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError, IntegrationState } from '../integrations/Shared'
import { Pager } from '../planning/Shared'
import { useMarketing } from './hooks'
import * as service from './service'

export function MarketingListPage() {
  useLocale()
  const id = useParams().id ?? ''
  const operation = useMarketing(id)
  if (!isUUID(id))
    return (
      <h1 className="page-title">{copy('Marketing not found', 'marketing')}</h1>
    )
  if (!operation.permissions.view) return <AccessDenied />
  return <Catalog key={JSON.stringify(operation.key)} operation={operation} />
}
function Catalog({
  operation,
}: {
  operation: ReturnType<typeof useMarketing>
}) {
  useLocale()
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const query = useQuery({
    queryKey: [...operation.key, 'catalog', refresh, history.at(-1)],
    retry: false,
    staleTime: 0,
    queryFn: ({ signal }) =>
      operation.read(() =>
        service.list(operation.clientID, history.at(-1)!, signal),
      ),
  })
  const busy = query.isFetching
  return (
    <section className="max-w-5xl">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            {copy('Client workspace · Marketing', 'marketing')}
          </p>
          <h1 className="page-title">Meta Ads</h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              "Stored reports for this client's Meta connections. Choose a connection and an ad-account date range.",
              'marketing',
            )}
          </p>
        </div>
      </header>
      <ClientNavigation clientID={operation.clientID} />
      <nav
        aria-label={copy('Connection actions', 'marketing')}
        className="mb-5 flex flex-wrap gap-2"
      >
        <Link
          className={buttonStyles()}
          to={`/app/clients/${operation.clientID}/profile`}
        >
          {copy('Client profile', 'marketing')}
        </Link>
        {operation.permissions.integrations ? (
          <Link
            className={buttonStyles()}
            to={`/app/clients/${operation.clientID}/integrations`}
          >
            {copy('Manage connections', 'marketing')}
          </Link>
        ) : null}
      </nav>
      <Button
        disabled={busy}
        onClick={() => {
          setHistory([''])
          setRefresh((v) => v + 1)
        }}
      >
        {copy('Refresh marketing connections', 'marketing')}
      </Button>
      {busy || query.isPending ? (
        <PageSkeleton
          label={copy('Loading marketing connections…', 'marketing')}
        />
      ) : query.isError ? (
        <IntegrationError
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : query.data.data.length ? (
        <Table caption={copy('Meta connections', 'marketing')}>
          <thead>
            <tr>
              <th>{copy('Connection', 'marketing')}</th>
              <th>{copy('Recorded state', 'marketing')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((record) => (
              <tr key={record.id}>
                <td>
                  <Link
                    className="break-all font-mono text-xs underline underline-offset-4"
                    to={`/app/clients/${operation.clientID}/marketing/${record.id}`}
                  >
                    {record.id}
                  </Link>
                </td>
                <td>
                  <IntegrationState record={record} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p role="status" className="my-5 rounded-md border border-line p-5">
          {copy(
            'No Meta connections on this page. An integration manager can add a pending ad account and install its user read token.',
            'marketing',
          )}
        </p>
      )}
      <Pager
        name={copy('Marketing connections', 'marketing')}
        history={history}
        next={!busy && !query.isError ? query.data?.next_id : null}
        busy={busy}
        onChange={setHistory}
      />
    </section>
  )
}
