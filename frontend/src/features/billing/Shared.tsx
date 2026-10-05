import { ClientNavigation } from '../clients/ClientNavigation'
import type { ReactNode } from 'react'
import { Button, Status } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { labels } from './models'
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
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {context?.name ?? 'Client workspace'} · Finance
          </p>
          <h1 className="page-title">
            {title}
          </h1>
          <p className="mt-2 text-xs text-muted">
            Exact amounts · Separate currencies · Due dates use the UTC
            calendar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={clientID} />
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
            ? 'danger'
            : 'neutral'
      }
    >
      {labels[record.status]}
    </Status>
  )
}
