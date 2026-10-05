import { copy, currentLocale, useLocale } from '../../i18n/index'
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
export function PlanningError({
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
          ? copy(error.message, 'planning')
          : copy('Unable to load planning data. Try again.', 'planning')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'planning')}
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
  useLocale()
  const { scope, permissions, client, parent } = operation
  const context =
    permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {context?.name ?? copy('Client workspace', 'planning')} ·{' '}
            {scope.planID
              ? copy('Milestones', 'planning')
              : copy('Planning', 'planning')}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Times shown in {{value1}} · Completion is manual.',
              'planning',
              { value1: deviceTimezone() },
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={scope.clientID} />
      {scope.planID ? (
        <nav
          aria-label={copy('Planning context', 'planning')}
          className="mb-5 flex gap-5 text-xs"
        >
          <Link
            className="underline underline-offset-4"
            to={pagePath({ clientID: scope.clientID }, scope.planID)}
          >
            {copy('Parent plan', 'planning')}
          </Link>
          <Link className="underline underline-offset-4" to={pagePath(scope)}>
            {copy('Milestones', 'planning')}
          </Link>
        </nav>
      ) : null}
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          {copy(
            'This client is archived. Planning history remains available; changes are unavailable.',
            'planning',
          )}
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
      (parent.data.archived_at ||
        ['completed', 'cancelled'].includes(parent.data.status)) ? (
        <p role="status" className="mb-4">
          {copy(
            'The parent plan is{{value1}} {{value2}}. Milestone history remains available. Reopen an unarchived plan before changing milestones.',
            'planning',
            {
              value1: ' ',
              value2: copy(parent.data.archived_at ? 'Archived' : labels[parent.data.status], 'planning').toLocaleLowerCase(currentLocale()),
            },
          )}
        </p>
      ) : null}
    </>
  )
}
export function PlanningState({ record }: { record: Summary }) {
  useLocale()
  return (
    <div className="flex flex-wrap gap-1.5">
      <Status tone={record.status === 'completed' ? 'success' : 'neutral'}>
        {copy(labels[record.status], 'planning')}
      </Status>
      {record.archived_at ? (
        <Status>{copy('Archived', 'planning')}</Status>
      ) : null}
    </div>
  )
}
export function PlanningTime({ value }: { value: string | null }) {
  useLocale()
  return value ? (
    <time dateTime={value}>{formatTime(value)}</time>
  ) : (
    <span className="text-muted">{copy('Not set', 'planning')}</span>
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
  useLocale()
  return (
    <nav
      aria-label={copy('{{name}} pagination', 'common', { name })}
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-xs text-muted">
        {copy('Up to 25 per page', 'planning')}
      </p>
      <div className="flex gap-2">
        <Button
          size="compact"
          disabled={history.length < 2 || busy}
          onClick={() => onChange(history.slice(0, -1))}
        >
          {copy('Previous', 'planning')}
        </Button>
        <Button
          size="compact"
          disabled={!next || busy}
          onClick={() => {
            if (next) onChange([...history, next])
          }}
        >
          {copy('Next', 'planning')}
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
  useLocale()
  return operation.error ? (
    <div className="mb-4">
      <p role="alert" className="text-danger-ink">
        {copy(operation.error, 'planning')}
      </p>
      <Button className="mt-2" onClick={reload}>
        {copy('Reload current data', 'planning')}
      </Button>
    </div>
  ) : null
}
