import { formatTime } from '../../lib/time'
import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useReminders } from './hooks'
import {
  ReminderHeader,
  ReminderError,
  ReminderState,
  ReminderTime,
} from './Shared'
import { ReminderActions, ReminderDismiss } from './ReminderActions'
import type { Summary } from './models'
import * as api from './service'
export function ReminderDetailPage() {
  useLocale()
  const { id = '', reminderID = '' } = useParams()
  return (
    <Detail key={id + ':' + reminderID} clientID={id} recordID={reminderID} />
  )
}
function Detail({
  clientID,
  recordID,
}: {
  clientID: string
  recordID: string
}) {
  useLocale()
  const operation = useReminders(clientID),
    location = useLocation()
  const [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: [...operation.key, 'detail', recordID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, recordID, signal)),
    enabled: operation.permissions.view,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === operation.auth.session?.user.id
        ? previous
        : undefined,
  })
  if (!operation.permissions.view) return <AccessDenied />
  if (query.isPending)
    return <PageSkeleton label={copy('Loading reminder…', 'reminders')} />
  if (query.isError && !query.data)
    return (
      <ReminderError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const record = query.data
  if (!record) return null
  const refresh = () => {
    operation.clearError()
    setNotice('')
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  const resourcePath =
    record.resource?.kind === 'task' && operation.permissions.taskView
      ? `/app/clients/${clientID}/tasks/${record.resource.id}`
      : record.resource?.kind === 'plan' && operation.permissions.planningView
        ? `/app/clients/${clientID}/plans/${record.resource.id}`
        : ''
  return (
    <section>
      <ReminderHeader title={record.title} operation={operation}>
        <Button
          disabled={query.isFetching || operation.pending}
          onClick={refresh}
        >
          {copy('Refresh reminder', 'reminders')}
        </Button>
      </ReminderHeader>
      {notice || location.state?.reminderSaved ? (
        <p role="status" className="mb-4">
          {notice ||
            (location.state.reminderSaved === 'created'
              ? copy('Reminder created.', 'reminders')
              : copy('Reminder updated.', 'reminders'))}
        </p>
      ) : null}
      {!confirm && copy(operation.error, 'reminders') ? (
        <div className="mb-4">
          <p role="alert" className="text-danger-ink">
            {copy(operation.error, 'reminders')}
          </p>
          <Button className="mt-2" onClick={refresh}>
            {copy('Reload current data', 'reminders')}
          </Button>
        </div>
      ) : null}
      {query.isError ? (
        <ReminderError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : null}
      <div className="mb-5">
        <ReminderState record={record} />
      </div>
      {record.status !== 'pending' ? (
        <p role="status" className="mb-4">
          {copy(
            'This reminder is terminal and read only. Its schedule and history are retained.',
            'reminders',
          )}
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="workspace-section">
          <h2 className="font-semibold">{copy('Description', 'reminders')}</h2>
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">
            {record.description ||
              copy('No description provided.', 'reminders')}
          </p>
          <h2 className="mt-5 font-semibold">
            {copy('Schedule', 'reminders')}
          </h2>
          <div className="mt-3 text-sm">
            <ReminderTime record={record} />
          </div>
          <p className="mt-2 break-all text-xs text-muted">
            {copy('UTC instant:', 'reminders')}{' '}
            <time dateTime={record.scheduled_at}>{record.scheduled_at}</time>
          </p>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            {[
              [copy('Completed', 'reminders'), record.completed_at],
              [copy('Dismissed', 'reminders'), record.dismissed_at],
            ]
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-1 break-all text-sm">
                    <time dateTime={value!}>{formatTime(value!, 'UTC')}</time>
                  </dd>
                </div>
              ))}
          </dl>
          <h2 className="mt-5 font-semibold">
            {copy('Resource reference', 'reminders')}
          </h2>
          <p className="mt-2 break-all text-xs">
            {record.resource
              ? `${statusLabel(record.resource.kind)} · ${record.resource.id}`
              : copy('No resource linked.', 'reminders')}
          </p>
          {resourcePath ? (
            <Link
              className="mt-2 inline-block text-xs underline"
              to={resourcePath}
            >
              {copy('Open linked {{value1}}', 'reminders', {
                value1: statusLabel(record.resource!.kind),
              })}
            </Link>
          ) : null}
        </section>
        <aside className="context-rail">
          <h2 className="font-semibold">
            {copy('Record context', 'reminders')}
          </h2>
          <dl className="mt-4 grid gap-4">
            {[
              [copy('Record ID', 'reminders'), record.id],
              [copy('Client ID', 'reminders'), clientID],
              [
                copy('Owner', 'reminders'),
                record.owner_id === operation.auth.session?.user.id
                  ? copy('Me', 'reminders')
                  : record.owner_id,
              ],
              [
                copy('Creator', 'reminders'),
                record.created_by === operation.auth.session?.user.id
                  ? copy('Me', 'reminders')
                  : record.created_by,
              ],
              [copy('Updated UTC', 'reminders'), formatTime(record.updated_at, 'UTC')],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 break-all text-xs">{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
      {!query.isFetching && !query.isError ? (
        <div className="mt-5">
          <ReminderActions
            record={record}
            operation={operation}
            onDismiss={setConfirm}
            onSuccess={setNotice}
          />
        </div>
      ) : null}
      {confirm && operation.permissions.update && operation.writable ? (
        <ReminderDismiss
          record={confirm}
          operation={operation}
          onClose={() => setConfirm(null)}
          onSuccess={() => {
            setConfirm(null)
            setNotice('Reminder dismissed.')
          }}
        />
      ) : null}
    </section>
  )
}
