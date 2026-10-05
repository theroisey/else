import { copy, useLocale } from '../../i18n/index'
import { PageSkeleton } from '../../components/ui'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { hasPermission } from '../auth/permissions'
import { useClients } from './hooks'
import { ClientHeader, ClientError, AccessDenied } from './Shared'
import { ClientForm } from './ClientForm'
import * as api from './service'
export function ClientEditorPage({ create = false }: { create?: boolean }) {
  useLocale()
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
    return <PageSkeleton label={copy('Loading client…', 'clients')} />
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
          title={copy('Archived client', 'clients')}
          description={copy(
            'This client is retained for history. Archived clients cannot be edited.',
            'clients',
          )}
        />
        <Link
          className="underline underline-offset-4"
          to={'/app/clients/' + id}
        >
          {copy('Open client workspace', 'clients')}
        </Link>
      </section>
    )
  return (
    <section>
      <ClientHeader
        title={
          create
            ? copy('Create client', 'clients')
            : copy('Edit client', 'clients')
        }
        description={
          create
            ? copy(
                'Create a profile. Access is assigned separately through roles.',
                'clients',
              )
            : copy('Update the complete profile, contacts and tags.', 'clients')
        }
      />
      {create ? (
        <ClientForm />
      ) : query.data ? (
        <ClientForm key={id} client={query.data} />
      ) : null}
    </section>
  )
}
