import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { IntegrationError, IntegrationState } from '../integrations/Shared'
import { Pager } from '../planning/Shared'
import { useCommerce } from './hooks'
import * as service from './service'

export function CommerceListPage() {
  const id = useParams().id ?? ''
  const operation = useCommerce(id)
  if (!isUUID(id)) return <h1 className="page-title">Commerce not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return <Catalog key={JSON.stringify(operation.key)} operation={operation} />
}
function Catalog({ operation }: { operation: ReturnType<typeof useCommerce> }) {
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const query = useQuery({ queryKey: [...operation.key, 'catalog', refresh, history.at(-1)], retry: false, staleTime: 0,
    queryFn: ({ signal }) => operation.read(() => service.list(operation.clientID, history.at(-1)!, signal)) })
  const busy = query.isFetching
  return <section className="max-w-5xl">
    <header className="page-header"><div><p className="eyebrow">Client workspace · Commerce</p><h1 className="page-title">WooCommerce</h1><p className="mt-2 text-sm text-muted">Stored order, refund and product-line observations. Choose a store connection, UTC period and currency.</p></div></header>
    <ClientNavigation clientID={operation.clientID} /><nav aria-label="Connection actions" className="mb-5 flex flex-wrap gap-2">
      <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/profile`}>Client profile</Link>
      {operation.permissions.integrations ? <Link className={buttonStyles()} to={`/app/clients/${operation.clientID}/integrations`}>Manage connections</Link> : null}
    </nav>
    <Button disabled={busy} onClick={() => { setHistory(['']); setRefresh(v => v + 1) }}>Refresh commerce connections</Button>
    {busy || query.isPending ? <PageSkeleton label="Loading commerce connections…" /> : query.isError ? <IntegrationError error={query.error} retry={() => void query.refetch()} /> : query.data.data.length ?
      <Table caption="WooCommerce connections"><thead><tr><th>Connection</th><th>Recorded state</th></tr></thead><tbody>{query.data.data.map(record => <tr key={record.id}><td><Link className="break-all font-mono text-xs underline underline-offset-4" to={`/app/clients/${operation.clientID}/commerce/${record.id}`}>{record.id}</Link></td><td><IntegrationState record={record} /></td></tr>)}</tbody></Table> : <p role="status" className="my-5 rounded-md border border-line p-5">No WooCommerce connections on this page. An integration manager can add a pending store and install its dedicated Read key.</p>}
    <Pager name="Commerce connections" history={history} next={!busy && !query.isError ? query.data?.next_id : null} busy={busy} onChange={setHistory} />
  </section>
}
