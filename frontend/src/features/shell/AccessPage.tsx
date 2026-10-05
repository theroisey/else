import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { useIsFetching } from '@tanstack/react-query'
import { AppearanceSettings } from '../appearance/Appearance'
import { Button, Status, Table, PageHeader } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { sessionKey } from '../auth/session'

export function AccessPage() {
  const auth = useAuth()
  const checking = useIsFetching({ queryKey: sessionKey }) > 0
  const grants = auth.session?.user.permissions ?? []
  return <section className="max-w-5xl">
    <PageHeader eyebrow="Account" title="My access" description="Your workspace preferences and effective account permissions.">
      <Button icon={faArrowRotateRight} loading={checking} loadingLabel="Refreshing access" onClick={() => { void auth.refresh() }}>Refresh access</Button>
    </PageHeader>
    <AppearanceSettings />
    <h2 className="mb-2 text-lg font-semibold">Effective permissions</h2><p className="text-sm text-muted">Client access applies only within its listed scope.</p>
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
