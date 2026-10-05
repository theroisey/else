import { SelectField } from '../../components/ui'
import { currentLocale } from '../../i18n'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import {
  Button,
  Status,
  Table,
  TextField,
  buttonStyles,
  PageSkeleton,
} from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { canListClients, canOpenClients, defaultFilter } from './models'
import type { Filter } from './models'
import { useClients } from './hooks'
import { AccessDenied, ClientError, ClientHeader } from './Shared'
import * as api from './service'

export function ClientsPage() {
  useLocale()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const canRead = canListClients(grants)
  const canCreate = hasPermission(grants, {
    permission: 'clients.create',
    scope: 'global',
  })
  const [draft, setDraft] = useState<Filter>(defaultFilter)
  const [filter, setFilter] = useState<Filter>(defaultFilter)
  const [history, setHistory] = useState([''])
  const cursor = history.at(-1) ?? ''
  const location = useLocation()
  const notice =
    location.state?.clientCreated === true
      ? copy(
          'Client created. Access is assigned separately through roles.',
          'clients',
        )
      : ''
  const query = useQuery({
    queryKey: [...operation.key, 'list', filter, cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.clients(filter, cursor, signal)),
    enabled: canRead,
  })
  if (!canOpenClients(grants)) return <AccessDenied />
  function apply(event: FormEvent) {
    event.preventDefault()
    setHistory([''])
    setFilter({
      ...draft,
      q: draft.q.trim(),
      tag: draft.tag.trim().toLowerCase(),
    })
  }
  return (
    <section>
      <ClientHeader
        title={copy('Clients', 'clients')}
        description={copy(
          'A private portfolio of client relationships. Open a record to review operations, finances and intelligence.',
          'clients',
        )}
      >
        <div className="flex flex-wrap gap-2">
          {canRead ? (
            <Button
              icon={faRotateRight}
              disabled={query.isFetching}
              onClick={() => {
                setHistory([''])
                void operation.cache.invalidateQueries({
                  queryKey: [...operation.key, 'list'],
                })
              }}
            >
              {copy('Refresh', 'clients')}
            </Button>
          ) : null}
          {canCreate ? (
            <Link
              className={buttonStyles({ variant: 'primary' })}
              to="/app/clients/new"
            >
              {copy('Create client', 'clients')}
            </Link>
          ) : null}
        </div>
      </ClientHeader>
      {notice ? (
        <p className="mb-4" role="status">
          {copy(notice, 'clients')}
        </p>
      ) : null}
      {!canRead ? (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('Client creation access', 'clients')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'You can create clients. Viewing their records requires separately assigned access.',
              'clients',
            )}
          </p>
        </div>
      ) : (
        <>
          <form
            className="mb-5 filter-bar filter-grid clients-filters"
            onSubmit={apply}
          >
            <TextField
              name="search"
              type="search"
              autoComplete="off"
              label={copy('Search by name', 'clients')}
              value={draft.q}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
            <TextField
              name="tag"
              autoComplete="off"
              label={copy('Tag', 'clients')}
              value={draft.tag}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
            />
            <SelectField
              name="status"
              label={copy('Status', 'clients')}
              value={draft.status}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: e.target.value as Filter['status'],
                })
              }
            >
              <option value="active">{copy('Active', 'clients')}</option>
              <option value="archived">{copy('Archived', 'clients')}</option>
              <option value="all">{copy('All', 'clients')}</option>
            </SelectField>
            <SelectField
              name="sort"
              label={copy('Sort', 'clients')}
              value={draft.sort}
              onChange={(e) =>
                setDraft({ ...draft, sort: e.target.value as Filter['sort'] })
              }
            >
              <option value="id">
                {copy('Client ID ascending', 'clients')}
              </option>
              <option value="-id">
                {copy('Client ID descending', 'clients')}
              </option>
            </SelectField>
            <div className="filter-actions">
              <Button type="submit">{copy('Apply filters', 'clients')}</Button>
            </div>
          </form>
          {query.isPending ? (
            <PageSkeleton label={copy('Loading clients…', 'clients')} />
          ) : query.isError ? (
            <ClientError
              error={query.error}
              retry={() => {
                void query.refetch()
              }}
            />
          ) : query.data.data.length === 0 ? (
            <div className="empty-state">
              <h2 className="font-semibold">
                {copy('No clients on this page', 'clients')}
              </h2>
              <p className="mt-2 text-muted">
                {copy(
                  canCreate
                    ? 'Adjust the filters, return to the previous page, or create a client.'
                    : 'Adjust the filters or return to the previous page.',
                  'clients',
                )}
              </p>
            </div>
          ) : (
            <Table caption={copy('Clients', 'clients')}>
              <thead>
                <tr>
                  <th scope="col">{copy('Client', 'clients')}</th>
                  <th scope="col">{copy('Status', 'clients')}</th>
                  <th scope="col">{copy('Tags', 'clients')}</th>
                  <th scope="col">{copy('Updated', 'clients')}</th>
                  <th scope="col">{copy('Workspace', 'clients')}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((client) => (
                  <tr key={client.id}>
                    <td className="min-w-48">
                      <p className="break-words font-medium">
                        <Link
                          to={`/app/clients/${client.id}`}
                          className="hover:underline underline-offset-4"
                        >
                          {client.name}
                        </Link>
                      </p>
                      {client.legal_name ? (
                        <p className="mt-1 break-words text-xs text-muted">
                          {client.legal_name}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <Status
                        tone={
                          client.status === 'active' ? 'success' : 'neutral'
                        }
                      >
                        {client.status === 'active'
                          ? copy('Active', 'clients')
                          : copy('Archived', 'clients')}
                      </Status>
                    </td>
                    <td className="min-w-32">
                      <span className="break-words text-xs text-muted">
                        {client.tags.join(', ') || copy('No tags', 'clients')}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">
                      <time dateTime={client.updated_at}>
                        {new Date(client.updated_at).toLocaleDateString(
                          currentLocale(),
                        )}
                      </time>
                    </td>
                    <td>
                      <Link
                        className={buttonStyles({ size: 'compact' })}
                        to={`/app/clients/${client.id}`}
                        aria-label={copy('Open {{value1}}', 'clients', {
                          value1: client.name,
                        })}
                      >
                        {copy('Open', 'clients')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <nav
            aria-label={copy('Client pagination', 'clients')}
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-xs text-muted">
              {copy(
                'Up to 25 clients per page · Only records you can view',
                'clients',
              )}
            </p>
            <div className="flex gap-2">
              <Button
                size="compact"
                disabled={history.length < 2 || query.isFetching}
                onClick={() => setHistory((h) => h.slice(0, -1))}
              >
                {copy('Previous', 'clients')}
              </Button>
              <Button
                size="compact"
                disabled={
                  query.isError ||
                  !query.data?.page.next_cursor ||
                  query.isFetching
                }
                onClick={() => {
                  const next = query.data?.page.next_cursor
                  if (next) setHistory((h) => [...h, next])
                }}
              >
                {copy('Next', 'clients')}
              </Button>
            </div>
          </nav>
        </>
      )}
    </section>
  )
}
