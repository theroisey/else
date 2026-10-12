import { time } from './time'
import { Link } from 'react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { faBell } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Button, PageSkeleton, buttonStyles } from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsHeader, OperationsError } from './Shared'
import * as api from './service'
const labels: Record<string, string> = {
  task_assigned: 'Task assigned',
  recurring_generated: 'Recurring task created',
  task_due: 'Task due soon',
  task_overdue: 'Task overdue',
  period_generated: 'Service billing period created',
  payment_due: 'Service payment due',
  payment_overdue: 'Service payment overdue',
  settlement_due: 'Internal settlement requires attention',
  settlement_recorded: 'Internal transfer recorded',
  payment_recorded: 'Customer payment recorded',
  payment_reversed: 'Customer refund recorded',
  automation_failed: 'Automation requires manager attention',
  created: 'New request submitted',
  accepted: 'Request accepted',
  rejected: 'Request rejected',
  assigned: 'Developer assigned',
  started: 'Work started',
  delivered: 'Delivery awaits your review',
  revision_requested: 'Revision requested',
  approved: 'Delivery approved',
  commented: 'New request comment',
  reopened: 'Request reopened',
  cancelled: 'Request cancelled',
}
export function NotificationControl() {
  useLocale()
  const op = useRecordOperations('operations')
  const query = useQuery({
    queryKey: [...op.key, 'notifications', ''],
    queryFn: ({ signal }) => op.read(() => api.inbox('', signal)),
    refetchInterval: 30_000,
  })
  return (
    <Link
      to="/app/notifications"
      className={buttonStyles({
        variant: 'ghost',
        size: 'compact',
        className: 'gap-2 px-2',
      })}
      aria-label={copy('Notifications', 'operations')}
    >
      <FontAwesomeIcon icon={faBell} aria-hidden="true" />
      {query.data?.unread_count !== '0' && query.data ? (
        <span className="text-xs tabular-nums">{query.data.unread_count}</span>
      ) : null}
    </Link>
  )
}
export function NotificationsPage() {
  useLocale()
  const op = useRecordOperations('operations')
  const [cursor, setCursor] = useState('')
  const query = useQuery({
    queryKey: [...op.key, 'notifications', cursor],
    queryFn: ({ signal }) => op.read(() => api.inbox(cursor, signal)),
    refetchInterval: 30_000,
  })
  return (
    <section>
      <OperationsHeader title={copy('Notifications', 'operations')}>
        <Button
          disabled={op.pending || query.isPending}
          onClick={() => {
            void op.run(() => api.mark('all'))
          }}
        >
          {copy('Mark all as read', 'operations')}
        </Button>
      </OperationsHeader>
      {query.isPending ? (
        <PageSkeleton label={copy('Loading notifications…', 'operations')} />
      ) : query.isError ? (
        <OperationsError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {query.data.data.map((n) => (
              <li
                key={n.id}
                className="flex flex-wrap justify-between gap-4 border-b border-line py-5"
              >
                <div>
                  <Link
                    className={n.read_at ? 'text-muted' : 'font-medium'}
                    to={
                      n.request_id
                        ? `/app/clients/${n.client_id}/requests/${n.request_id}`
                        : n.task_id
                          ? `/app/clients/${n.client_id}/tasks/${n.task_id}`
                          : n.period_id
                            ? `/app/clients/${n.client_id}/finance/${n.period_id}`
                            : n.template_id
                              ? `/app/clients/${n.client_id}/recurring-tasks/${n.template_id}`
                              : `/app/clients/${n.client_id}/finance`
                    }
                    onClick={() => {
                      if (!n.read_at) void op.run(() => api.mark(n.id))
                    }}
                  >
                    {copy(labels[n.kind] ?? 'Operational update', 'operations')}
                  </Link>
                  <p className="mt-2 text-xs text-muted">
                    {time(n.created_at)} ·{' '}
                    {copy(n.read_at ? 'Read' : 'Unread', 'operations')}
                  </p>
                </div>
                {!n.read_at ? (
                  <Button
                    size="compact"
                    disabled={op.pending}
                    onClick={() => {
                      void op.run(() => api.mark(n.id))
                    }}
                  >
                    {copy('Mark as read', 'operations')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {!query.data.data.length ? (
            <p className="py-8 text-muted">
              {copy('No notifications require attention.', 'operations')}
            </p>
          ) : null}
          <div className="mt-5 flex gap-3">
            {cursor ? (
              <Button onClick={() => setCursor('')}>
                {copy('Latest notifications', 'operations')}
              </Button>
            ) : null}
            {query.data.page.next_cursor ? (
              <Button onClick={() => setCursor(query.data!.page.next_cursor!)}>
                {copy('Older notifications', 'operations')}
              </Button>
            ) : null}
          </div>
        </>
      )}
      {op.error ? (
        <p role="alert" className="mt-4 text-danger-ink">
          {copy(op.error)}
        </p>
      ) : null}
    </section>
  )
}
