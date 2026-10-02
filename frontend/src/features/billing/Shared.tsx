import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, Status, buttonStyles } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { labels, pagePath } from './models'
import type { Collection } from './models'
import type { useBilling } from './hooks'
export { Pager } from '../planning/Shared'
export type Operation = ReturnType<typeof useBilling>
export function BillingError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? error.message
          : 'Unable to load finance data. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
export function BillingHeader({
  title,
  operation,
  children,
}: {
  title: string
  operation: Operation
  children?: ReactNode
}) {
  const { clientID, permissions, client } = operation,
    context =
      permissions.clientView && !client.isError ? client.data : undefined
  const links = [
    { visible: !!context, label: 'Overview', path: `/app/clients/${clientID}` },
    {
      visible: permissions.taskView,
      label: 'Tasks',
      path: `/app/clients/${clientID}/tasks`,
    },
    {
      visible: permissions.planningView,
      label: 'Planning',
      path: `/app/clients/${clientID}/plans`,
    },
    {
      visible: permissions.reminderView,
      label: 'Reminders',
      path: `/app/clients/${clientID}/reminders`,
    },
    { visible: true, label: 'Finance', path: pagePath(clientID) },
    {
      visible: permissions.activityView,
      label: 'Activity',
      path: `/app/clients/${clientID}/activity`,
    },
    {
      visible: permissions.auditView,
      label: 'Audit history',
      path: `/app/clients/${clientID}/audit`,
    },
  ]
  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">
            {context?.name ?? 'Client workspace'} · Finance
          </p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-2 text-xs text-muted">
            Exact amounts · Separate currencies · Due dates use the UTC
            calendar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        {links
          .filter((l) => l.visible)
          .map((l) => (
            <Link
              key={l.label}
              className={buttonStyles({ size: 'compact' })}
              to={l.path}
            >
              {l.label}
            </Link>
          ))}
      </nav>
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          This client is archived. Finance history remains available; new
          changes are unavailable.
        </p>
      ) : null}
      {permissions.clientView && client.isError ? (
        <BillingError
          error={client.error}
          retry={() => void client.refetch()}
        />
      ) : null}
    </>
  )
}
export function BillingState({ record }: { record: Collection }) {
  return (
    <Status
      tone={
        record.status === 'paid'
          ? 'success'
          : record.status === 'overdue'
            ? 'warning'
            : 'neutral'
      }
    >
      {labels[record.status]}
    </Status>
  )
}
