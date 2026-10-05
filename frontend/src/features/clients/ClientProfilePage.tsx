import { currentLocale } from '../../i18n'
import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from './ClientNavigation'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  Status,
  buttonStyles,
  PageSkeleton,
} from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { useClients } from './hooks'
import { AccessDenied, ClientError } from './Shared'
import * as api from './service'
import type { Client } from './models'

export function ClientProfilePage() {
  useLocale()
  const { id = '' } = useParams()
  return <ClientWorkspace key={id} id={id} />
}
function ClientWorkspace({ id }: { id: string }) {
  useLocale()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const allowed = hasPermission(grants, {
    permission: 'clients.view',
    scope: 'client',
    clientID: id,
  })
  const query = useQuery({
    queryKey: [...operation.key, 'detail', id],
    queryFn: ({ signal }) => operation.read(() => api.client(id, signal)),
    enabled: allowed,
  })
  const [confirm, setConfirm] = useState<Client | null>(null)
  const [notice, setNotice] = useState('')
  const location = useLocation()
  if (!allowed) return <AccessDenied />
  if (query.isPending)
    return <PageSkeleton label={copy('Loading client…', 'clients')} />
  if (query.isError)
    return (
      <ClientError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const client = query.data
  const active = client.status === 'active'
  const update =
    active &&
    hasPermission(grants, {
      permission: 'clients.update',
      scope: 'client',
      clientID: id,
    })
  const archive =
    active &&
    hasPermission(grants, {
      permission: 'clients.archive',
      scope: 'client',
      clientID: id,
    })
  const saved =
    location.state?.clientSaved === 'created'
      ? copy('Client created.', 'clients')
      : location.state?.clientSaved === 'updated'
        ? copy('Client updated.', 'clients')
        : ''
  return (
    <section>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">{copy('Client workspace', 'clients')}</p>
          <h1 className="page-title">{client.name}</h1>
          {client.legal_name ? (
            <p className="mt-2 break-words text-muted">{client.legal_name}</p>
          ) : null}
          <div className="mt-3">
            <Status tone={active ? 'success' : 'neutral'}>
              {active ? copy('Active', 'clients') : copy('Archived', 'clients')}
            </Status>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch()
            }}
          >
            {copy('Refresh client', 'clients')}
          </Button>
          {update ? (
            <Link className={buttonStyles()} to={`/app/clients/${id}/edit`}>
              {copy('Edit client', 'clients')}
            </Link>
          ) : null}
          {archive ? (
            <Button
              variant="danger"
              onClick={() => {
                operation.clearError()
                setConfirm(client)
              }}
            >
              {copy('Archive client', 'clients')}
            </Button>
          ) : null}
        </div>
      </header>
      {notice || saved ? (
        <p className="mb-4" role="status">
          {notice ? copy(notice, 'clients') : saved}
        </p>
      ) : null}
      {!active ? (
        <p className="mb-4 rounded-md border border-line bg-surface-subtle p-3 text-sm">
          {copy(
            'Archived {{value1}}. This profile and its history are retained. Changes and new assignments are unavailable.',
            'clients',
            {
              value1: new Date(client.archived_at!).toLocaleString(
                currentLocale(),
              ),
            },
          )}
        </p>
      ) : null}
      <ClientNavigation clientID={id} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-5">
          <section className="workspace-section">
            <h2 className="font-semibold">{copy('Profile', 'clients')}</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted">
                  {copy('Legacy profile website', 'clients')}
                </dt>
                <dd className="mt-1 break-all">
                  {client.website || copy('Not provided', 'clients')}
                  <Link
                    className="mt-2 block text-xs underline underline-offset-4"
                    to={`/app/clients/${id}/websites`}
                  >
                    {copy('Manage websites', 'clients')}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">
                  {copy('Tags', 'clients')}
                </dt>
                <dd className="mt-1 break-words">
                  {client.tags.join(', ') || copy('No tags', 'clients')}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">
                  {copy('Internal notes', 'clients')}
                </dt>
                <dd className="mt-1 break-words leading-6">
                  {client.notes || copy('No notes', 'clients')}
                </dd>
              </div>
            </dl>
          </section>
          <section className="workspace-section">
            <h2 className="font-semibold">{copy('Contacts', 'clients')}</h2>
            {client.contacts.length ? (
              <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                {client.contacts.map((contact, i) => (
                  <li
                    key={i}
                    className="min-w-0 rounded-sm border border-line p-3"
                  >
                    <h3 className="break-words font-semibold">
                      {contact.name}
                    </h3>
                    <p className="mt-1 break-all text-xs text-muted">
                      {contact.email || copy('No email', 'clients')}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted">
                      {contact.phone || copy('No phone', 'clients')}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-muted">
                {copy('No contacts provided.', 'clients')}
              </p>
            )}
          </section>
        </div>
        <aside className="context-rail">
          <h2 className="font-semibold">{copy('Record context', 'clients')}</h2>
          <dl className="mt-4 grid gap-4">
            <div>
              <dt className="text-xs text-muted">
                {copy('Client ID', 'clients')}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs">{id}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {copy('Created', 'clients')}
              </dt>
              <dd className="mt-1 text-xs">
                <time dateTime={client.created_at}>
                  {new Date(client.created_at).toLocaleString(currentLocale())}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {copy('Updated', 'clients')}
              </dt>
              <dd className="mt-1 text-xs">
                <time dateTime={client.updated_at}>
                  {new Date(client.updated_at).toLocaleString(currentLocale())}
                </time>
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted">
            {copy(
              'Times use your device’s timezone. Access is assigned through roles.',
              'clients',
            )}
          </p>
          <Link
            className="mt-4 block text-sm underline underline-offset-4"
            to="/app/clients"
          >
            {copy('All clients', 'clients')}
          </Link>
        </aside>
      </div>
      {confirm && archive ? (
        <Dialog
          open
          title={copy('Archive {{value1}}?', 'clients', {
            value1: confirm.name,
          })}
          description={copy(
            'The profile and history will remain available to authorized users. Editing and new assignments will be unavailable.',
            'clients',
          )}
          onClose={() => {
            if (!operation.pending) setConfirm(null)
          }}
        >
          {copy(operation.error, 'clients') ? (
            <div>
              <p role="alert" className="text-danger-ink">
                {copy(operation.error, 'clients')}
              </p>
              <p className="mt-2 text-xs text-muted">
                {copy(
                  'Cancel and refresh the client before reviewing another attempt.',
                  'clients',
                )}
              </p>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={operation.pending}
              onClick={() => setConfirm(null)}
            >
              {copy('Cancel', 'clients')}
            </Button>
            <Button
              variant="danger"
              loading={operation.pending}
              disabled={!!operation.error}
              loadingLabel={copy('Archiving client', 'clients')}
              onClick={() => {
                void operation
                  .run(() => api.archive(id, confirm.revision))
                  .then((result) => {
                    if (result) {
                      setConfirm(null)
                      setNotice('Client archived.')
                    }
                  })
              }}
            >
              {copy('Confirm archive', 'clients')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
