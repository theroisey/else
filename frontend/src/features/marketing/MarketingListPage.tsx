import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, buttonStyles } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError, IntegrationState } from '../integrations/Shared'
import { Pager } from '../planning/Shared'
import { useMarketing } from './hooks'
import * as service from './service'

export function MarketingListPage() {
  const id = useParams().id ?? ''
  const operation = useMarketing(id)
  if (!isUUID(id)) return <h1>Marketing not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return <Catalog key={JSON.stringify(operation.key)} operation={operation} />
}
function Catalog({ operation }: { operation: ReturnType<typeof useMarketing> }) {
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const query = useQuery({ queryKey: [...operation.key, 'catalog', refresh, history.at(-1)], retry: false, staleTime: 0,
    queryFn: ({ signal }) => operation.read(() => service.list(operation.clientID, history.at(-1)!, signal)) })
  const busy = query.isFetching
  return <section className="max-w-5xl">
    <header className="mb-5"><p className="eyebrow">Client workspace · Marketing</p><h1 className="mt-2 text-2xl font-semibold">Meta Ads</h1><p className="mt-2 text-sm text-muted">Stored reports for this client's Meta connections. Choose a connection and an ad-account date range.</p></header>
    <nav aria-label="Client modules" className="mb-5 flex flex-wrap gap-2">
      <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/profile`}>Client profile</Link>
      {operation.permissions.integrations ? <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/integrations`}>Manage connections</Link> : null}
    </nav>
    <Button disabled={busy} onClick={() => { setHistory(['']); setRefresh(v => v + 1) }}>Refresh marketing connections</Button>
    {busy || query.isPending ? <p role="status" className="py-8">Loading marketing connections…</p> : query.isError ? <IntegrationError error={query.error} retry={() => void query.refetch()} /> : query.data.data.length ?
      <Table caption="Meta connections"><thead><tr><th>Connection</th><th>Recorded state</th></tr></thead><tbody>{query.data.data.map(record => <tr key={record.id}><td><Link className="break-all font-mono text-xs underline underline-offset-4" to={`/app/clients/${operation.clientID}/marketing/${record.id}`}>{record.id}</Link></td><td><IntegrationState record={record} /></td></tr>)}</tbody></Table> : <p role="status" className="my-5 rounded-md border border-line p-5">No Meta connections on this page. An integration manager can add a pending ad account and install its user read token.</p>}
    <Pager name="Marketing connections" history={history} next={!busy && !query.isError ? query.data?.next_id : null} busy={busy} onChange={setHistory} />
  </section>
}
