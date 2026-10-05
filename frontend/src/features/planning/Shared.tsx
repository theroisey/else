import { ClientNavigation } from '../clients/ClientNavigation'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, Status } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { deviceTimezone, formatTime } from '../../lib/time'
import { labels, pagePath } from './models'
import type { Summary } from './models'
import type { usePlanning } from './hooks'
export type Operation = ReturnType<typeof usePlanning>
export function PlanningError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError ? error.message : 'Unable to load planning data. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
export function PlanningHeader({
  title,
  operation,
  children,
}: {
  title: string
  operation: Operation
  children?: ReactNode
}) {
  const { scope, permissions, client, parent } = operation
  const context = permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {context?.name ?? 'Client workspace'} · {scope.planID ? 'Milestones' : 'Planning'}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            Times shown in {deviceTimezone()} · Completion is manual.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={scope.clientID} />
      {scope.planID ? <nav aria-label="Planning context" className="mb-5 flex gap-5 text-xs"><Link className="underline underline-offset-4" to={pagePath({ clientID: scope.clientID }, scope.planID)}>Parent plan</Link><Link className="underline underline-offset-4" to={pagePath(scope)}>Milestones</Link></nav> : null}
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          This client is archived. Planning history remains available; changes are unavailable.
        </p>
      ) : null}
      {permissions.clientView && client.isError ? (
        <PlanningError
          error={client.error}
          retry={() => {
            void client.refetch()
          }}
        />
      ) : null}
      {scope.planID && parent.isError ? (
        <PlanningError
          error={parent.error}
          retry={() => {
            void parent.refetch()
          }}
        />
      ) : null}
      {scope.planID &&
      parent.data &&
      (parent.data.archived_at || ['completed', 'cancelled'].includes(parent.data.status)) ? (
        <p role="status" className="mb-4">
          The parent plan is{' '}
          {parent.data.archived_at ? 'archived' : labels[parent.data.status].toLowerCase()}.
          Milestone history remains available. Reopen an unarchived plan before changing milestones.
        </p>
      ) : null}
    </>
  )
}
export function PlanningState({ record }: { record: Summary }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status tone={record.status === 'completed' ? 'success' : 'neutral'}>
        {labels[record.status]}
      </Status>
      {record.archived_at ? <Status>Archived</Status> : null}
    </div>
  )
}
export function PlanningTime({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{formatTime(value)}</time>
  ) : (
    <span className="text-muted">Not set</span>
  )
}
export function Pager({
  name,
  history,
  next,
  busy,
  onChange,
}: {
  name: string
  history: string[]
  next?: string | null | undefined
  busy: boolean
  onChange: (history: string[]) => void
}) {
  return (
    <nav
      aria-label={`${name} pagination`}
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-xs text-muted">Up to 25 per page</p>
      <div className="flex gap-2">
        <Button
          size="compact"
          disabled={history.length < 2 || busy}
          onClick={() => onChange(history.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          size="compact"
          disabled={!next || busy}
          onClick={() => {
            if (next) onChange([...history, next])
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  )
}
export function OperationNotice({
  operation,
  reload,
}: {
  operation: Operation
  reload: () => void
}) {
  return operation.error ? (
    <div className="mb-4">
      <p role="alert" className="text-danger-ink">
        {operation.error}
      </p>
      <Button className="mt-2" onClick={reload}>
        Reload current data
      </Button>
    </div>
  ) : null
}
