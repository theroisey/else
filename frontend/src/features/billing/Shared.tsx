import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? copy(error.message, 'billing')
          : copy('Unable to load finance data. Try again.', 'billing')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'billing')}
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
  useLocale()
  const { clientID, permissions, client } = operation,
    context =
      permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('{{value1}} · Finance', 'billing', {
              value1: context?.name ?? copy('Client workspace', 'common'),
            })}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Exact amounts · Separate currencies · Due dates use the UTC calendar.',
              'billing',
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={clientID} />
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          {copy(
            'This client is archived. Finance history remains available; new changes are unavailable.',
            'billing',
          )}
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
  useLocale()
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
      {copy(labels[record.status], 'billing')}
    </Status>
  )
}
