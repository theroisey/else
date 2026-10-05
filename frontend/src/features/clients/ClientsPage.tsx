import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, Table, TextField, buttonStyles, PageSkeleton } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { canListClients, canOpenClients, defaultFilter } from './models'
import type { Filter } from './models'
import { useClients } from './hooks'
import { AccessDenied, ClientError, ClientHeader } from './Shared'
import * as api from './service'

export function ClientsPage() {
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
      ? 'Client created. Access is assigned separately through roles.'
      : ''
  const query = useQuery({
    queryKey: [...operation.key, 'list', filter, cursor],
    queryFn: ({ signal }) => operation.read(() => api.clients(filter, cursor, signal)),
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
      <ClientHeader title="Clients" description="A private portfolio of client relationships. Open a record to review operations, finances and intelligence.">
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
              Refresh
            </Button>
          ) : null}
          {canCreate ? (
            <Link className={buttonStyles({ variant: 'primary' })} to="/app/clients/new">
              Create client
            </Link>
          ) : null}
        </div>
      </ClientHeader>
      {notice ? (
        <p className="mb-4" role="status">
          {notice}
        </p>
      ) : null}
      {!canRead ? (
        <div className="empty-state">
          <h2 className="font-semibold">Client creation access</h2>
          <p className="mt-2 text-muted">
            You can create clients. Viewing their records requires separately assigned access.
          </p>
        </div>
      ) : (
        <>
          <form
            className="mb-5 grid items-end gap-3 filter-bar sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_minmax(8rem,1fr)_10rem_12rem_auto]"
            onSubmit={apply}
          >
            <TextField
              label="Search by name"
              value={draft.q}
              maxLength={100}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
            <TextField
              label="Tag"
              value={draft.tag}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
            />
            <label className="grid gap-1.5 font-semibold">
              Status
              <select
                className="ui-input font-normal"
                value={draft.status}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    status: e.target.value as Filter['status'],
                  })
                }
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </label>
            <label className="grid gap-1.5 font-semibold">
              Sort
              <select
                className="ui-input font-normal"
                value={draft.sort}
                onChange={(e) => setDraft({ ...draft, sort: e.target.value as Filter['sort'] })}
              >
                <option value="id">Client ID ascending</option>
                <option value="-id">Client ID descending</option>
              </select>
            </label>
            <Button type="submit">Apply filters</Button>
          </form>
          {query.isPending ? (
            <PageSkeleton label="Loading clients…" />
          ) : query.isError ? (
            <ClientError
              error={query.error}
              retry={() => {
                void query.refetch()
              }}
            />
          ) : query.data.data.length === 0 ? (
            <div className="empty-state">
              <h2 className="font-semibold">No clients on this page</h2>
              <p className="mt-2 text-muted">
                Adjust the filters, return to the previous page
                {canCreate ? ', or create a client' : ''}.
              </p>
            </div>
          ) : (
            <Table caption="Clients">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tags</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Workspace</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((client) => (
                  <tr key={client.id}>
                    <td className="min-w-48">
                      <p className="break-words font-medium"><Link to={`/app/clients/${client.id}`} className="hover:underline underline-offset-4">{client.name}</Link></p>
                      {client.legal_name ? (
                        <p className="mt-1 break-words text-xs text-muted">{client.legal_name}</p>
                      ) : null}
                    </td>
                    <td>
                      <Status tone={client.status === 'active' ? 'success' : 'neutral'}>
                        {client.status === 'active' ? 'Active' : 'Archived'}
                      </Status>
                    </td>
                    <td className="min-w-32">
                      <span className="break-words text-xs text-muted">
                        {client.tags.join(', ') || 'No tags'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">
                      <time dateTime={client.updated_at}>
                        {new Date(client.updated_at).toLocaleDateString()}
                      </time>
                    </td>
                    <td>
                      <Link
                        className={buttonStyles({ size: 'compact' })}
                        to={`/app/clients/${client.id}`}
                        aria-label={`Open ${client.name}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <nav
            aria-label="Client pagination"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-xs text-muted">
              Up to 25 clients per page · Only records you can view
            </p>
            <div className="flex gap-2">
              <Button
                size="compact"
                disabled={history.length < 2 || query.isFetching}
                onClick={() => setHistory((h) => h.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                size="compact"
                disabled={query.isError || !query.data?.page.next_cursor || query.isFetching}
                onClick={() => {
                  const next = query.data?.page.next_cursor
                  if (next) setHistory((h) => [...h, next])
                }}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </section>
  )
}
