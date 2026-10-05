import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  PageHeader,
  PageSkeleton,
  Status,
} from '../../components/ui'
import { useClients } from '../clients/hooks'
import { ClientNavigation } from '../clients/ClientNavigation'
import { AccessDenied, ClientError } from '../clients/Shared'
import { isUUID } from '../auth/session'
import { hasPermission } from '../auth/permissions'
import * as clients from '../clients/service'
import * as api from './service'
import { WebsiteForm } from './WebsiteForm'

export function WebsitesPage() {
  useLocale()
  const { id = '' } = useParams()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const view =
    isUUID(id) &&
    hasPermission(grants, {
      permission: 'clients.view',
      scope: 'client',
      clientID: id,
    })
  const [history, setHistory] = useState([''])
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active')
  const [create, setCreate] = useState(false)
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: [...operation.key, 'websites', id, status, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() => api.list(id, history.at(-1)!, status, signal)),
    enabled: view,
  })
  const client = useQuery({
    queryKey: [...operation.key, 'detail', id],
    queryFn: ({ signal }) => operation.read(() => clients.client(id, signal)),
    enabled: view,
  })
  const manage =
    client.data?.status === 'active' &&
    hasPermission(grants, {
      permission: 'clients.update',
      scope: 'client',
      clientID: id,
    })
  if (!isUUID(id))
    return <h1 className="page-title">{copy('Client not found', 'clients')}</h1>
  if (!view) return <AccessDenied />
  return (
    <section>
      <PageHeader
        eyebrow={client.data?.name ?? copy('Client workspace', 'websites')}
        title={copy('Websites', 'websites')}
        description={copy(
          'Independent properties, with their own integrations and measured reports.',
          'websites',
        )}
      >
        {manage ? (
          <Button variant="primary" onClick={() => setCreate(true)}>
            {copy('Add website', 'websites')}
          </Button>
        ) : null}
      </PageHeader>
      <ClientNavigation clientID={id} />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-3">
          <span className="text-xs font-semibold">
            {copy('Website status', 'websites')}
          </span>
          <select
            className="ui-input w-auto"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status)
              setHistory([''])
            }}
          >
            <option value="active">{copy('Active', 'websites')}</option>
            <option value="archived">{copy('Archived', 'websites')}</option>
            <option value="all">{copy('All websites', 'websites')}</option>
          </select>
        </label>
        <Button
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch()
            void client.refetch()
          }}
        >
          {copy('Refresh', 'websites')}
        </Button>
      </div>
      {query.isPending || client.isPending ? (
        <PageSkeleton label={copy('Loading websites…', 'websites')} />
      ) : query.isError || client.isError ? (
        <ClientError
          error={query.error ?? client.error}
          retry={() => {
            void query.refetch()
            void client.refetch()
          }}
        />
      ) : query.data.data.length ? (
        <ul className="website-portfolio">
          {query.data.data.map((w) => (
            <li key={w.id}>
              <Link
                to={api.websiteBase(id, w.id)}
                className="website-portfolio-link"
              >
                <div className="min-w-0">
                  <p className="eyebrow">{w.name}</p>
                  <h2 className="mt-2 break-all font-display text-2xl">
                    {w.domain || w.url}
                  </h2>
                  {w.description ? (
                    <p className="mt-2 break-words text-sm text-muted">
                      {w.description}
                    </p>
                  ) : null}
                </div>
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
                  {w.is_primary ? (
                    <Status tone="neutral">
                      {copy('Primary', 'websites')}
                    </Status>
                  ) : null}
                  {w.needs_review ? (
                    <Status tone="warning">
                      {copy('Review legacy URL', 'websites')}
                    </Status>
                  ) : null}
                  {w.status === 'archived' ? (
                    <Status tone="neutral">
                      {copy('Archived', 'websites')}
                    </Status>
                  ) : null}
                  <span className="text-xs font-semibold">
                    {copy('Open workspace →', 'websites')}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No websites in this view', 'websites')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Add a property to manage its integrations and reports independently.',
              'websites',
            )}
          </p>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Button
          disabled={history.length === 1 || query.isFetching}
          onClick={() => setHistory((v) => v.slice(0, -1))}
        >
          {copy('Previous', 'websites')}
        </Button>
        <p className="text-xs text-muted">
          {copy('Page {{value1}}', 'websites', { value1: history.length })}
        </p>
        <Button
          disabled={!query.data?.page.next_cursor || query.isFetching}
          onClick={() => {
            if (query.data?.page.next_cursor)
              setHistory((v) => [...v, query.data.page.next_cursor!])
          }}
        >
          {copy('Next', 'websites')}
        </Button>
      </div>
      <Dialog
        open={create}
        onClose={() => setCreate(false)}
        title={copy('Add website', 'websites')}
        description={copy(
          'Create an independent property under this client.',
          'websites',
        )}
        variant="drawer"
      >
        <WebsiteForm
          clientID={id}
          onSaved={(website) => {
            setCreate(false)
            navigate(api.websiteBase(id, website))
          }}
          onCancel={() => setCreate(false)}
        />
      </Dialog>
    </section>
  )
}
