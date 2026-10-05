import { copy, useLocale } from '../../i18n/index'
import type { ReactNode } from 'react'
import { Button, PageHeader } from '../../components/ui'
import { APIError } from '../../services/authenticated'
export function ClientHeader({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  useLocale()
  return (
    <PageHeader
      eyebrow={copy('Clients', 'clients')}
      title={title}
      description={description}
    >
      {children}
    </PageHeader>
  )
}
export function ClientError({
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
          ? copy(error.message, 'clients')
          : copy('Unable to load current client data. Try again.', 'clients')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'clients')}
      </Button>
    </div>
  )
}
export function AccessDenied() {
  useLocale()
  return (
    <section>
      <h1 className="page-title">{copy('Access denied', 'clients')}</h1>
      <p className="mt-3 text-muted" role="alert">
        {copy('Your current permissions do not allow this page.', 'clients')}
      </p>
    </section>
  )
}
