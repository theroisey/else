import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { hasPermission } from '../auth/permissions'
import { useClients } from './hooks'
import { ClientHeader, ClientError, AccessDenied } from './Shared'
import { ClientForm } from './ClientForm'
import * as api from './service'
export function ClientEditorPage({ create = false }: { create?: boolean }) {
  const { id = '' } = useParams()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const allowed = create
    ? hasPermission(grants, { permission: 'clients.create', scope: 'global' })
    : hasPermission(grants, {
        permission: 'clients.view',
        scope: 'client',
        clientID: id,
      }) &&
      hasPermission(grants, {
        permission: 'clients.update',
        scope: 'client',
        clientID: id,
      })
  const query = useQuery({
    queryKey: [...operation.key, 'detail', id],
    queryFn: ({ signal }) => operation.read(() => api.client(id, signal)),
    enabled: allowed && !create,
  })
  if (!allowed) return <AccessDenied />
  if (!create && query.isPending)
    return (
      <p role="status" aria-busy="true">
        Loading client…
      </p>
    )
  if (!create && query.isError)
    return (
      <ClientError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  if (!create && query.data?.status === 'archived')
    return (
      <section>
        <ClientHeader
          title="Archived client"
          description="This client is retained for history. Archived clients cannot be edited."
        />
        <Link className="underline underline-offset-4" to={'/app/clients/' + id}>
          Open client workspace
        </Link>
      </section>
    )
  return (
    <section>
      <ClientHeader
        title={create ? 'Create client' : 'Edit client'}
        description={
          create
            ? 'Create a profile. Access is assigned separately through roles.'
            : 'Update the complete profile, contacts and tags.'
        }
      />
      {create ? <ClientForm /> : query.data ? <ClientForm key={id} client={query.data} /> : null}
    </section>
  )
}
