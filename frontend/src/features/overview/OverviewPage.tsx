import { Link, useLocation, useParams } from 'react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Status, buttonStyles } from '../../components/ui'
import { formatTime } from '../../lib/time'
import { APIError } from '../../services/authenticated'
import { hasPermission } from '../auth/permissions'
import { isUUID, sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import { useRecordOperations } from '../auth/useRecordOperations'
import { AccessDenied } from '../clients/Shared'
import { TaskQueue, ReminderQueue } from './Attention'
import { FinancialPosition } from './FinancialPosition'
import * as service from './service'

export function OverviewPage() {
  const client = useParams().id ?? ''
  const operation = useRecordOperations('overview', client)
  const grants = operation.auth.session?.user.permissions ?? []
  if (!isUUID(client))
    return (
      <section>
        <h1 className="text-2xl font-semibold">Overview not found</h1>
        <p className="mt-3 text-muted">This client address is not valid.</p>
      </section>
    )
  if (
    !hasPermission(grants, {
      permission: 'clients.view',
      scope: 'client',
      clientID: client,
    })
  )
    return <AccessDenied />
  return (
    <Workspace
      key={JSON.stringify(operation.key)}
      client={client}
      operation={operation}
    />
  )
}

function Workspace({
  client,
  operation,
}: {
  client: string
  operation: ReturnType<typeof useRecordOperations>
}) {
  const location = useLocation()
  const [refreshing, setRefreshing] = useState(false)
  const grants = operation.auth.session!.user.permissions
  const query = useQuery({
    queryKey: operation.key,
    queryFn: async (context) => {
      // Let React's development effect replay share the initial query promise
      // before consuming its cancellation signal and starting the network read.
      await Promise.resolve()
      const signal = context.signal
      if (signal.aborted) throw new DOMException('Read cancelled', 'AbortError')
      return operation.read(() => service.read(client, grants, signal))
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  async function refresh() {
    setRefreshing(true)
    try {
      await operation.auth.refresh()
      const current = operation.cache.getQueryData<{ session: Session | null }>(
        sessionKey,
      )?.session
      if (
        current &&
        current.user.id === operation.auth.session?.user.id &&
        JSON.stringify(current.user.permissions) === JSON.stringify(grants)
      )
        await query.refetch()
    } finally {
      setRefreshing(false)
    }
  }
  if (refreshing || query.isPending || query.isFetching)
    return (
      <section aria-busy="true">
        <h1 className="text-2xl font-semibold">Client overview</h1>
        <p role="status" className="mt-4 text-muted">
          Loading overview…
        </p>
      </section>
    )
  if (query.isError)
    return (
      <section>
        <h1 className="text-2xl font-semibold">Overview unavailable</h1>
        <p className="mt-3 text-muted" role="alert">
          {query.error instanceof APIError
            ? query.error.message
            : 'Unable to load the overview. Try again.'}
        </p>
        <Button className="mt-4" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </section>
    )
  const data = query.data
  const base = `/app/clients/${client}`
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID: client })
  const saved =
    location.state?.clientSaved === 'created'
      ? 'Client created.'
      : location.state?.clientSaved === 'updated'
        ? 'Client updated.'
        : ''
  const modules = [
    { label: 'Tasks', path: 'tasks', shown: !!data.tasks },
    { label: 'Planning', path: 'plans', shown: has('planning.view') },
    { label: 'Reminders', path: 'reminders', shown: !!data.reminders },
    { label: 'Finance', path: 'billing', shown: !!data.finance },
    { label: 'Pricing', path: 'pricing', shown: has('pricing.view') },
    { label: 'Integrations', path: 'integrations', shown: has('integrations.view') },
    { label: 'Web analytics', path: 'analytics', shown: has('analytics.view') },
    { label: 'Activity', path: 'activity', shown: !!data.activity },
    {
      label: 'Audit history',
      path: 'audit',
      shown: hasPermission(grants, {
        permission: 'audit.view',
        scope: 'global',
      }),
    },
  ]
  return (
    <section className="max-w-6xl">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Client workspace · Overview</p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">
            {data.client.name}
          </h1>
          <div className="mt-3">
            <Status
              tone={data.client.status === 'active' ? 'success' : 'neutral'}
            >
              {data.client.status === 'active' ? 'Active' : 'Archived'}
            </Status>
          </div>
        </div>
        <Button onClick={() => void refresh()}>Refresh overview</Button>
      </header>
      {saved ? (
        <p role="status" className="mb-4">
          {saved}
        </p>
      ) : null}
      {data.client.status === 'archived' ? (
        <p className="mb-4 border-l-2 border-line pl-3 text-sm text-muted">
          Archived {formatTime(data.client.archived_at!)}. The overview and
          history remain readable; changes are unavailable.
        </p>
      ) : null}
      <nav
        aria-label="Client modules"
        className="mb-6 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        <span
          aria-current="page"
          className="self-center px-3 text-sm font-semibold"
        >
          Overview
        </span>
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={`${base}/profile`}
        >
          Profile
        </Link>
        {modules
          .filter((v) => v.shown)
          .map((v) => (
            <Link
              key={v.path}
              className={buttonStyles({ size: 'compact' })}
              to={`${base}/${v.path}`}
            >
              {v.label}
            </Link>
          ))}
      </nav>
      <p className="mb-7 text-xs text-muted">
        As of <time dateTime={data.as_of}>{formatTime(data.as_of)}</time> ·
        Upcoming window ends{' '}
        <time dateTime={data.horizon_end}>{formatTime(data.horizon_end)}</time>.
        Task times use your device’s timezone; reminders retain their scheduled
        timezone.
      </p>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          {data.tasks || data.reminders ? (
            <>
              <section aria-labelledby="attention-title">
                <p className="eyebrow">Act first</p>
                <h2
                  id="attention-title"
                  className="mt-2 text-xl font-semibold tracking-tight"
                >
                  Needs attention
                </h2>
                <p className="mt-2 text-sm text-muted">
                  Overdue tasks and pending reminders whose scheduled time has
                  arrived.
                </p>
                {data.tasks ? (
                  <TaskQueue
                    heading="Overdue tasks"
                    queue={data.tasks.overdue}
                    client={client}
                    empty="No overdue tasks."
                  />
                ) : null}
                {data.reminders ? (
                  <ReminderQueue
                    heading="Due reminders"
                    queue={data.reminders.due}
                    client={client}
                    empty="No reminders due."
                  />
                ) : null}
              </section>
              <section
                aria-labelledby="upcoming-title"
                className="border-t border-line pt-6"
              >
                <h2 id="upcoming-title" className="text-lg font-semibold">
                  Next seven days
                </h2>
                {data.tasks ? (
                  <TaskQueue
                    heading="Tasks due soon"
                    queue={data.tasks.due_soon}
                    client={client}
                    empty="No tasks due in this window."
                  />
                ) : null}
                {data.reminders ? (
                  <ReminderQueue
                    heading="Upcoming reminders"
                    queue={data.reminders.upcoming}
                    client={client}
                    empty="No reminders scheduled in this window."
                  />
                ) : null}
              </section>
            </>
          ) : null}
          {data.finance && !data.tasks && !data.reminders ? (
            <FinancialPosition finance={data.finance} base={base} />
          ) : null}
        </div>
        <div className="min-w-0 space-y-8">
          {data.finance && (data.tasks || data.reminders) ? (
            <FinancialPosition finance={data.finance} base={base} />
          ) : null}
          {data.activity ? (
            <section
              aria-labelledby="activity-title"
              className="border-t border-line pt-6 xl:border-t-0 xl:pt-0"
            >
              <h2 id="activity-title" className="text-lg font-semibold">
                Recent activity
              </h2>
              <p className="mt-2 text-xs text-muted">
                Recorded changes visible with your current access.
              </p>
              {data.activity.items.length ? (
                <ol
                  aria-label="Recent client activity"
                  className="mt-4 divide-y divide-line"
                >
                  {data.activity.items.map((event) => (
                    <li className="py-3" key={event.id}>
                      <p className="text-sm font-semibold">{event.summary}</p>
                      <time
                        dateTime={event.occurred_at}
                        className="mt-1 block break-all font-mono text-xs text-muted"
                      >
                        {event.occurred_at}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-4 text-sm text-muted">
                  No recent activity visible.
                </p>
              )}
              <Link
                className="mt-4 inline-block text-sm underline underline-offset-4"
                to={`${base}/activity`}
              >
                {data.activity.has_more
                  ? 'More activity available · Open activity'
                  : 'Open activity'}
              </Link>
            </section>
          ) : null}
          <aside
            aria-labelledby="integrations-title"
            className="border-t border-line pt-6"
          >
            <h2 id="integrations-title" className="text-sm font-semibold">
              Integration data unavailable
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              External performance totals are not included in this overview.
              Authorized users can open measured GA4 reports from Web analytics.
              Marketing and commerce synchronization remain unavailable.
            </p>
          </aside>
        </div>
      </div>
      {!data.tasks && !data.reminders && !data.finance && !data.activity ? (
        <p className="mt-6 text-sm text-muted">
          No operational sections are available with your current access.
        </p>
      ) : null}
      <Link
        to="/app/clients"
        className="mt-8 inline-block text-sm underline underline-offset-4"
      >
        All clients
      </Link>
    </section>
  )
}
