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
import { useAnalytics } from './hooks'
import * as service from './service'

export function AnalyticsListPage() {
  useLocale()
  const id = useParams().id ?? ''
  const operation = useAnalytics(id)
  if (!isUUID(id))
    return (
      <h1 className="page-title">{copy('Analytics not found', 'analytics')}</h1>
    )
  if (!operation.permissions.view) return <AccessDenied />
  return <Catalog key={JSON.stringify(operation.key)} operation={operation} />
}
function Catalog({
  operation,
}: {
  operation: ReturnType<typeof useAnalytics>
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
            {copy('Client workspace · Web analytics', 'analytics')}
          </p>
          <h1 className="page-title">Google Analytics 4</h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              "Stored reports for this client's GA4 connections. Choose a connection and a property date range.",
              'analytics',
            )}
          </p>
        </div>
      </header>
      <ClientNavigation clientID={operation.clientID} />
      <nav
        aria-label={copy('Connection actions', 'analytics')}
        className="mb-5 flex flex-wrap gap-2"
      >
        <Link
          className={buttonStyles()}
          to={`/app/clients/${operation.clientID}/profile`}
        >
          {copy('Client profile', 'analytics')}
        </Link>
        {operation.permissions.integrations ? (
          <Link
            className={buttonStyles()}
            to={`/app/clients/${operation.clientID}/integrations`}
          >
            {copy('Manage connections', 'analytics')}
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
        {copy('Refresh analytics connections', 'analytics')}
      </Button>
      {busy || query.isPending ? (
        <PageSkeleton
          label={copy('Loading analytics connections…', 'analytics')}
        />
      ) : query.isError ? (
        <IntegrationError
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : query.data.data.length ? (
        <Table caption={copy('GA4 connections', 'analytics')}>
          <thead>
            <tr>
              <th>{copy('Connection', 'analytics')}</th>
              <th>{copy('Recorded state', 'analytics')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((record) => (
              <tr key={record.id}>
                <td>
                  <Link
                    className="break-all font-mono text-xs underline underline-offset-4"
                    to={`/app/clients/${operation.clientID}/analytics/${record.id}`}
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
            'No GA4 connections on this page. An integration manager can add a pending property and install its read-only key.',
            'analytics',
          )}
        </p>
      )}
      <Pager
        name={copy('Analytics connections', 'analytics')}
        history={history}
        next={!busy && !query.isError ? query.data?.next_id : null}
        busy={busy}
        onChange={setHistory}
      />
    </section>
  )
}
