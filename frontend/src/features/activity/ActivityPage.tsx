import { formatTime } from '../../lib/time'
import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import { useState } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, PageSkeleton } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { Pager } from '../planning/Shared'
import { activityPermissions } from './permissions'
import { kindLabels } from './models'
import * as service from './service'

export function ActivityPage() {
  useLocale()
  const clientID = useParams().id!
  const operation = useRecordOperations('activity', clientID)
  const permissions = activityPermissions(
    operation.auth.session?.user.permissions ?? [],
    clientID,
  )
  if (!isUUID(clientID))
    return (
      <section>
        <h1 className="page-title">{copy('Activity not found', 'activity')}</h1>
        <p className="mt-3 text-muted">
          {copy('This client address is not valid.', 'activity')}
        </p>
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
  useLocale()
  const [history, setHistory] = useState([''])
  const [refresh, setRefresh] = useState(0)
  const query = useQuery({
    queryKey: [...operation.key, 'list', refresh, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() => service.list(clientID, history.at(-1)!, signal)),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
  const rows =
    !query.isError && !query.isFetching
      ? query.data?.data.filter(permissions.allows)
      : undefined
  function reload() {
    setHistory([''])
    setRefresh((v) => v + 1)
  }
  return (
    <section className="max-w-5xl">
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('Client workspace · History', 'activity')}
          </p>
          <h1 className="page-title">{copy('Activity', 'activity')}</h1>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'Recorded changes, newest first. Times are shown in UTC.',
              'activity',
            )}
          </p>
          <p className="mt-2 break-all font-mono text-xs text-muted">
            {copy('Client {{value1}}', 'activity', { value1: clientID })}
          </p>
        </div>
        <Button disabled={query.isFetching} onClick={reload}>
          {copy('Refresh activity', 'activity')}
        </Button>
      </header>
      <ClientNavigation clientID={clientID} />
      {query.isFetching || query.isPending ? (
        <PageSkeleton label={copy('Loading activity…', 'activity')} />
      ) : query.isError ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">
            {query.error instanceof APIError
              ? copy(query.error.message, 'activity')
              : copy('Unable to load activity. Try again.', 'activity')}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              void query.refetch()
            }}
          >
            {copy('Try again', 'activity')}
          </Button>
        </div>
      ) : rows?.length ? (
        <ol
          aria-label={copy('Client activity', 'activity')}
          className="activity-timeline"
        >
          {rows.map((event) => (
            <li
              key={event.id}
              className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
            >
              <div className="min-w-0">
                <p className="font-semibold">
                  {copy(event.summary, 'activity')}
                </p>
                <p className="mt-1 break-all text-xs text-muted">
                  {copy(kindLabels[event.resource_kind], 'activity')}{' '}
                  {copy('reference ·', 'activity')}{' '}
                  <span className="font-mono">{event.resource_id}</span>
                </p>
              </div>
              <time
                className="break-all font-mono text-xs text-muted sm:text-right"
                dateTime={event.occurred_at}
              >
                {formatTime(event.occurred_at, 'UTC')}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No activity on this page', 'activity')}
          </h2>
          <p className="mt-2 text-sm text-muted">
            {copy(
              'There are no recorded events visible with your current access. Refresh to check for newer changes.',
              'activity',
            )}
          </p>
        </div>
      )}
      <Pager
        name={copy('Activity', 'activity')}
        history={history}
        next={
          !query.isError && !query.isFetching
            ? query.data?.page.next_cursor
            : null
        }
        busy={query.isFetching}
        onChange={setHistory}
      />
      <p className="mt-4 text-xs text-muted">
        {copy(
          'Each page reflects current access. Refresh returns to the newest events.',
          'activity',
        )}
      </p>
    </section>
  )
}
