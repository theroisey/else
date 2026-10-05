import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, buttonStyles } from '../../components/ui'
import {
  labels,
  milestoneTransitions,
  planTransitions,
  planStates,
  milestoneStates,
  pagePath,
  terminal,
} from './models'
import type { Summary, State } from './models'
import type { Operation } from './Shared'
import * as api from './service'
export function PlanningActions({
  record,
  operation,
  onArchive,
  onSuccess,
}: {
  record: Summary
  operation: Operation
  onArchive: (r: Summary) => void
  onSuccess: (message: string) => void
}) {
  useLocale()
  const [next, setNext] = useState<State | ''>('')
  if (record.archived_at || !operation.writable) return null
  const busy = operation.pending || !!operation.error
  const choices = record.plan_id
    ? milestoneTransitions[record.status as (typeof milestoneStates)[number]]
    : planTransitions[record.status as (typeof planStates)[number]]
  return (
    <div className="record-actions flex flex-wrap items-center gap-2">
      {operation.permissions.update && !terminal(record.status) ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={pagePath(operation.scope, record.id) + '/edit'}
        >
          {copy('Edit {{value1}}', 'planning', {
            value1: copy(record.plan_id ? 'milestone' : 'plan', 'planning'),
          })}
        </Link>
      ) : null}
      {operation.permissions.update ? (
        <form
          className="inline-flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!next || busy) return
            void operation
              .run(() =>
                api.transition(
                  operation.scope,
                  record.id,
                  next,
                  record.revision,
                ),
              )
              .then((result) => {
                if (result) {
                  setNext('')
                  onSuccess('Status updated.')
                }
              })
          }}
        >
          <label className="sr-only" htmlFor={'planning-status-' + record.id}>
            {copy('Next status for {{value1}}', 'planning', {
              value1: record.title,
            })}
          </label>
          <select
            id={'planning-status-' + record.id}
            className="ui-input min-h-8 w-32 min-w-28 py-1 text-xs"
            value={next}
            disabled={busy}
            onChange={(e) => setNext(e.target.value as State | '')}
          >
            <option value="">
              {terminal(record.status)
                ? copy('Reopen as…', 'planning')
                : copy('Change to…', 'planning')}
            </option>
            {choices.map((s) => (
              <option key={s} value={s}>
                {copy(labels[s], 'planning')}
              </option>
            ))}
          </select>
          <Button
            size="compact"
            type="submit"
            disabled={!next || busy}
            aria-label={copy('Change status of {{value1}}', 'planning', {
              value1: record.title,
            })}
          >
            {copy('Apply status', 'planning')}
          </Button>
        </form>
      ) : null}
      {operation.permissions.archive ? (
        <Button
          size="compact"
          variant="danger-ghost"
          disabled={busy}
          aria-label={copy('Archive {{value1}}', 'planning', {
            value1: record.title,
          })}
          onClick={() => {
            operation.clearError()
            onArchive(record)
          }}
        >
          {copy('Archive', 'planning')}
        </Button>
      ) : null}
    </div>
  )
}
export function PlanningArchive({
  record,
  operation,
  onClose,
  onSuccess,
}: {
  record: Summary
  operation: Operation
  onClose: () => void
  onSuccess: () => void
}) {
  useLocale()
  return (
    <Dialog
      open
      title={copy('Archive {{value1}}?', 'planning', { value1: record.title })}
      description={
        record.plan_id
          ? copy(
              'The milestone, linked references and history will be retained. Further changes will be unavailable.',
              'planning',
            )
          : copy(
              'The plan, milestones, linked references and history will be retained. Further changes will be unavailable.',
              'planning',
            )
      }
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {copy(operation.error, 'planning') ? (
        <div>
          <p role="alert" className="text-danger-ink">
            {copy(operation.error, 'planning')}
          </p>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Cancel and refresh before reviewing another attempt.',
              'planning',
            )}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          {copy('Cancel', 'planning')}
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          loadingLabel={copy('Archiving record', 'planning')}
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() =>
                api.archive(operation.scope, record.id, record.revision),
              )
              .then((r) => {
                if (r) onSuccess()
              })
          }}
        >
          {copy('Confirm archive', 'planning')}
        </Button>
      </div>
    </Dialog>
  )
}
