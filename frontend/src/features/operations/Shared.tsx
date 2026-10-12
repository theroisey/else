import type { ReactNode } from 'react'
import { copy, useLocale } from '../../i18n'
import { Button, PageHeader, Status } from '../../components/ui'
import { ClientNavigation } from '../clients/ClientNavigation'
import { APIError } from '../../services/authenticated'
import { labels } from './models'
import type { RequestSummary } from './models'
export function RequestState({ status }: { status: RequestSummary['status'] }) {
  useLocale()
  return (
    <Status
      tone={
        status === 'approved'
          ? 'success'
          : ['rejected', 'cancelled'].includes(status)
            ? 'danger'
            : ['delivered', 'revision_requested'].includes(status)
              ? 'warning'
              : 'neutral'
      }
    >
      {copy(labels[status], 'operations')}
    </Status>
  )
}
export function OperationsHeader({
  title,
  client,
  children,
}: {
  title: string
  client?: string | undefined
  children?: ReactNode
}) {
  useLocale()
  return (
    <>
      <PageHeader
        eyebrow={copy('Daily operations', 'operations')}
        title={title}
      >
        {children}
      </PageHeader>
      {client ? <ClientNavigation clientID={client} /> : null}
    </>
  )
}
export function OperationsError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  useLocale()
  return (
    <div role="alert" className="workspace-section">
      <p>
        {copy(
          error instanceof APIError
            ? error.message
            : 'Unable to load this workspace.',
          'operations',
        )}
      </p>
      <Button className="mt-4" onClick={retry}>
        {copy('Retry', 'common')}
      </Button>
    </div>
  )
}
