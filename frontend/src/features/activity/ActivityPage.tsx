import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { Pager } from '../planning/Shared'
import { activityPermissions } from './permissions'
import { kindLabels } from './models'
import * as service from './service'

export function ActivityPage() {
  const clientID = useParams().id!
  const operation = useRecordOperations('activity', clientID)
  const permissions = activityPermissions(operation.auth.session?.user.permissions ?? [], clientID)
  if (!isUUID(clientID))
    return (
      <section>
        <h1 className="text-2xl font-semibold">Activity not found</h1>
        <p className="mt-3 text-muted">This client address is not valid.</p>
      </section>
    )
  if (!permissions.view) return <AccessDenied />
  return (
    <Timeline
      key={JSON.stringify(operation.key)}
      clientID={clientID}
      operation={operation}
      permissions={permissions}
    />
  )
}

function Timeline({
  clientID,
  operation,
  permissions,
}: {
  clientID: string
  operation: ReturnType<typeof useRecordOperations>
  permissions: ReturnType<typeof activityPermissions>
}) {
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const query = useQuery({
    queryKey: [...operation.key, 'list', refresh, history.at(-1)],
    queryFn: ({ signal }) => operation.read(() => service.list(clientID, history.at(-1)!, signal)),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  const rows =
    !query.isError && !query.isFetching ? query.data?.data.filter(permissions.allows) : undefined
  function reload() {
    setHistory([''])
    setRefresh((v) => v + 1)
  }
  return (
    <section className="max-w-5xl">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Client workspace · History</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-2 text-sm text-muted">
            Recorded changes, newest first. Times are shown in UTC.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-muted">Client {clientID}</p>
        </div>
        <Button disabled={query.isFetching} onClick={reload}>
          Refresh activity
        </Button>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}`}>
          Overview
        </Link>
        {permissions.taskView ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/tasks`}>
            Tasks
          </Link>
        ) : null}
        {permissions.planningView ? (
          <Link className={buttonStyles({ size: 'compact' })} to={`/app/clients/${clientID}/plans`}>
            Planning
          </Link>
        ) : null}
        {permissions.reminderView ? (
          <Link
            className={buttonStyles({ size: 'compact' })}
            to={`/app/clients/${clientID}/reminders`}
          >
            Reminders
          </Link>
        ) : null}
        <span aria-current="page" className="self-center px-3 text-sm font-semibold">
          Activity
        </span>
      </nav>
      {query.isFetching || query.isPending ? (
        <p role="status" className="py-8 text-muted">
          Loading activity…
        </p>
      ) : query.isError ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">
            {query.error instanceof APIError
              ? query.error.message
              : 'Unable to load activity. Try again.'}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              void query.refetch()
            }}
          >
            Try again
          </Button>
        </div>
      ) : rows?.length ? (
        <ol
          aria-label="Client activity"
          className="divide-y divide-line rounded-md border border-line bg-surface"
        >
          {rows.map((event) => (
            <li
              key={event.id}
              className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
            >
              <div className="min-w-0">
                <p className="font-semibold">{event.summary}</p>
                <p className="mt-1 break-all text-xs text-muted">
                  {kindLabels[event.resource_kind]} reference ·{' '}
                  <span className="font-mono">{event.resource_id}</span>
                </p>
              </div>
              <time
                className="break-all font-mono text-xs text-muted sm:text-right"
                dateTime={event.occurred_at}
              >
                {event.occurred_at}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-md border border-line bg-surface-subtle p-6">
          <h2 className="font-semibold">No activity on this page</h2>
          <p className="mt-2 text-sm text-muted">
            There are no recorded events visible with your current access. Refresh to check for
            newer changes.
          </p>
        </div>
      )}
      <Pager
        name="Activity"
        history={history}
        next={!query.isError && !query.isFetching ? query.data?.page.next_cursor : null}
        busy={query.isFetching}
        onChange={setHistory}
      />
      <p className="mt-4 text-xs text-muted">
        Each page reflects current access. Refresh returns to the newest events.
      </p>
    </section>
  )
}
