import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import { Link, useLocation, useParams } from 'react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Status, PageSkeleton } from '../../components/ui'
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
  useLocale()
  const client = useParams().id ?? ''
  const operation = useRecordOperations('overview', client)
  const grants = operation.auth.session?.user.permissions ?? []
  if (!isUUID(client))
    return (
      <section>
        <h1 className="page-title">{copy('Overview not found', 'overview')}</h1>
        <p className="mt-3 text-muted">
          {copy('This client address is not valid.', 'overview')}
        </p>
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
  useLocale()
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
      if (signal.aborted)
        throw new DOMException('Read cancelled', 'AbortError')
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
    return <PageSkeleton label={copy('Loading overview…', 'overview')} />
  if (query.isError)
    return (
      <section>
        <h1 className="page-title">
          {copy('Overview unavailable', 'overview')}
        </h1>
        <p className="mt-3 text-muted" role="alert">
          {query.error instanceof APIError
            ? copy(query.error.message, 'overview')
            : copy('Unable to load the overview. Try again.', 'overview')}
        </p>
        <Button className="mt-4" onClick={() => void query.refetch()}>
          {copy('Try again', 'overview')}
        </Button>
      </section>
    )
  const data = query.data
  const base = `/app/clients/${client}`
  const saved =
    location.state?.clientSaved === 'created'
      ? copy('Client created.', 'overview')
      : location.state?.clientSaved === 'updated'
        ? copy('Client updated.', 'overview')
        : ''
  return (
    <section className="max-w-6xl">
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('Client dossier · Overview', 'overview')}
          </p>
          <h1 className="page-title">{data.client.name}</h1>
          <div className="mt-3">
            <Status
              tone={data.client.status === 'active' ? 'success' : 'neutral'}
            >
              {data.client.status === 'active'
                ? copy('Active', 'overview')
                : copy('Archived', 'overview')}
            </Status>
          </div>
        </div>
        <Button onClick={() => void refresh()}>
          {copy('Refresh overview', 'overview')}
        </Button>
      </header>
      {saved ? (
        <p role="status" className="mb-4">
          {saved}
        </p>
      ) : null}
      {data.client.status === 'archived' ? (
        <p className="mb-4 border-l-2 border-line pl-3 text-sm text-muted">
          {copy(
            'Archived {{value1}}. The overview and history remain readable; changes are unavailable.',
            'overview',
            { value1: formatTime(data.client.archived_at!) },
          )}
        </p>
      ) : null}
      <ClientNavigation clientID={client} />
      <p className="mb-7 text-xs text-muted">
        {copy('As of', 'overview')}{' '}
        <time dateTime={data.as_of}>{formatTime(data.as_of)}</time>{' '}
        {copy('· Upcoming window ends', 'overview')}{' '}
        <time dateTime={data.horizon_end}>{formatTime(data.horizon_end)}</time>
        {copy(
          '. Task times use your device’s timezone; reminders retain their scheduled timezone.',
          'overview',
        )}
      </p>
      {data.finance ? (
        <FinancialPosition finance={data.finance} base={base} />
      ) : null}
      <div className="overview-workspace">
        <div className="min-w-0 space-y-8">
          {data.tasks || data.reminders ? (
            <>
              <section aria-labelledby="attention-title">
                <p className="eyebrow">{copy('Act first', 'overview')}</p>
                <h2
                  id="attention-title"
                  className="mt-2 text-xl font-semibold tracking-tight"
                >
                  {copy('Needs attention', 'overview')}
                </h2>
                <p className="mt-2 text-sm text-muted">
                  {copy(
                    'Overdue tasks and pending reminders whose scheduled time has arrived.',
                    'overview',
                  )}
                </p>
                {data.tasks ? (
                  <TaskQueue
                    heading={copy('Overdue tasks', 'overview')}
                    queue={data.tasks.overdue}
                    client={client}
                    empty={copy('No overdue tasks.', 'overview')}
                  />
                ) : null}
                {data.reminders ? (
                  <ReminderQueue
                    heading={copy('Due reminders', 'overview')}
                    queue={data.reminders.due}
                    client={client}
                    empty={copy('No reminders due.', 'overview')}
                  />
                ) : null}
              </section>
              <section
                aria-labelledby="upcoming-title"
                className="border-t border-line pt-6"
              >
                <h2 id="upcoming-title" className="text-lg font-semibold">
                  {copy('Next seven days', 'overview')}
                </h2>
                {data.tasks ? (
                  <TaskQueue
                    heading={copy('Tasks due soon', 'overview')}
                    queue={data.tasks.due_soon}
                    client={client}
                    empty={copy('No tasks due in this window.', 'overview')}
                  />
                ) : null}
                {data.reminders ? (
                  <ReminderQueue
                    heading={copy('Upcoming reminders', 'overview')}
                    queue={data.reminders.upcoming}
                    client={client}
                    empty={copy(
                      'No reminders scheduled in this window.',
                      'overview',
                    )}
                  />
                ) : null}
              </section>
            </>
          ) : null}
        </div>
        <div className="min-w-0 space-y-8">
          {data.activity ? (
            <section
              aria-labelledby="activity-title"
              className="border-t border-line pt-6 xl:border-t-0 xl:pt-0"
            >
              <h2 id="activity-title" className="text-lg font-semibold">
                {copy('Recent activity', 'overview')}
              </h2>
              <p className="mt-2 text-xs text-muted">
                {copy(
                  'Recorded changes visible with your current access.',
                  'overview',
                )}
              </p>
              {data.activity.items.length ? (
                <ol
                  aria-label={copy('Recent client activity', 'overview')}
                  className="mt-4 divide-y divide-line"
                >
                  {data.activity.items.map((event) => (
                    <li className="py-3" key={event.id}>
                      <p className="text-sm font-semibold">
                        {copy(event.summary, 'overview')}
                      </p>
                      <time
                        dateTime={event.occurred_at}
                        className="mt-1 block break-all font-mono text-xs text-muted"
                      >
                        {formatTime(event.occurred_at, 'UTC')}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-4 text-sm text-muted">
                  {copy('No recent activity visible.', 'overview')}
                </p>
              )}
              <Link
                className="mt-4 inline-block text-sm underline underline-offset-4"
                to={`${base}/activity`}
              >
                {data.activity.has_more
                  ? copy('More activity available · Open activity', 'overview')
                  : copy('Open activity', 'overview')}
              </Link>
            </section>
          ) : null}
          <aside
            aria-labelledby="integrations-title"
            className="border-t border-line pt-6"
          >
            <h2 id="integrations-title" className="text-sm font-semibold">
              {copy('Measured intelligence', 'overview')}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {copy(
                'Performance reports are available in their dedicated workspaces. Authorized users can open measured GA4 reports from Web analytics, WooCommerce reports from Commerce and Meta Ads reports from Marketing.',
                'overview',
              )}
            </p>
          </aside>
        </div>
      </div>
      {!data.tasks && !data.reminders && !data.finance && !data.activity ? (
        <p className="mt-6 text-sm text-muted">
          {copy(
            'No operational sections are available with your current access.',
            'overview',
          )}
        </p>
      ) : null}
      <Link
        to="/app/clients"
        className="mt-8 inline-block text-sm underline underline-offset-4"
      >
        {copy('All clients', 'overview')}
      </Link>
    </section>
  )
}
