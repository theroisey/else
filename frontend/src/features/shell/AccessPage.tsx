import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { useIsFetching } from '@tanstack/react-query'
import { Button, Status, Table } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { sessionKey } from '../auth/session'

export function AccessPage() {
  const auth = useAuth()
  const checking = useIsFetching({ queryKey: sessionKey }) > 0
  const grants = auth.session?.user.permissions ?? []
  return <section className="max-w-5xl">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="eyebrow">Account</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">My access</h1><p className="mt-3 max-w-xl leading-6 text-muted">Effective permissions returned for your account. Client access applies only within its listed scope.</p></div>
      <Button icon={faArrowRotateRight} loading={checking} loadingLabel="Refreshing access" onClick={() => { void auth.refresh() }}>Refresh access</Button>
    </div>
    <div className="mt-7">
      {grants.length ? <Table caption="Your effective permissions">
        <thead><tr><th scope="col">Permission</th><th scope="col">Scope</th><th scope="col">Client</th></tr></thead>
        <tbody>{grants.map((grant) => <tr key={`${grant.permission}:${grant.scope}:${grant.client_id ?? ''}`}>
          <th scope="row" className="whitespace-nowrap font-mono text-xs">{grant.permission}</th>
          <td><Status>{grant.scope === 'global' ? 'Global' : 'Client'}</Status></td>
          <td className="whitespace-nowrap font-mono text-xs text-muted">{grant.client_id ?? '—'}</td>
        </tr>)}</tbody>
      </Table> : <div className="rounded-md border border-line bg-surface p-6"><h2 className="font-semibold">No permissions assigned</h2><p className="mt-2 leading-6 text-muted">Your session is active. Ask an administrator if you need access to additional capabilities.</p></div>}
    </div>
    <p className="mt-5 text-xs leading-6 text-muted">Permissions are checked by the server for every protected operation. This page does not grant or change access.</p>
  </section>
}
