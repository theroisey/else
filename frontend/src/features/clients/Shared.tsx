import type { ReactNode } from 'react'
import { Button } from '../../components/ui'
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
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="eyebrow">Clients</p>
        <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 max-w-xl leading-6 text-muted">{description}</p>
      </div>
      {children}
    </header>
  )
}
export function ClientError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? error.message
          : 'Unable to load current client data. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
export function AccessDenied() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-3 text-muted" role="alert">
        Your current permissions do not allow this page.
      </p>
    </section>
  )
}
