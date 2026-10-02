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
  const [next, setNext] = useState<State | ''>('')
  if (record.archived_at || !operation.writable) return null
  const busy = operation.pending || !!operation.error
  const choices = record.plan_id
    ? milestoneTransitions[record.status as (typeof milestoneStates)[number]]
    : planTransitions[record.status as (typeof planStates)[number]]
  return (
    <div className="flex flex-wrap items-center gap-2">
      {operation.permissions.update && !terminal(record.status) ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={pagePath(operation.scope, record.id) + '/edit'}
        >
          Edit {record.plan_id ? 'milestone' : 'plan'}
        </Link>
      ) : null}
      {operation.permissions.update ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!next || busy) return
            void operation
              .run(() => api.transition(operation.scope, record.id, next, record.revision))
              .then((result) => {
                if (result) {
                  setNext('')
                  onSuccess('Status updated.')
                }
              })
          }}
        >
          <label className="sr-only" htmlFor={'planning-status-' + record.id}>
            Next status for {record.title}
          </label>
          <select
            id={'planning-status-' + record.id}
            className="ui-input min-w-36 text-xs"
            value={next}
            disabled={busy}
            onChange={(e) => setNext(e.target.value as State | '')}
          >
            <option value="">{terminal(record.status) ? 'Reopen as…' : 'Change to…'}</option>
            {choices.map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
          <Button
            size="compact"
            type="submit"
            disabled={!next || busy}
            aria-label={`Change status of ${record.title}`}
          >
            Apply status
          </Button>
        </form>
      ) : null}
      {operation.permissions.archive ? (
        <Button
          size="compact"
          variant="danger"
          disabled={busy}
          aria-label={`Archive ${record.title}`}
          onClick={() => {
            operation.clearError()
            onArchive(record)
          }}
        >
          Archive
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
  return (
    <Dialog
      open
      title={`Archive ${record.title}?`}
      description={
        record.plan_id
          ? 'The milestone, linked references and history will be retained. Further changes will be unavailable.'
          : 'The plan, milestones, linked references and history will be retained. Further changes will be unavailable.'
      }
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {operation.error ? (
        <div>
          <p role="alert" className="text-danger-ink">
            {operation.error}
          </p>
          <p className="mt-2 text-xs text-muted">
            Cancel and refresh before reviewing another attempt.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          loadingLabel="Archiving record"
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() => api.archive(operation.scope, record.id, record.revision))
              .then((r) => {
                if (r) onSuccess()
              })
          }}
        >
          Confirm archive
        </Button>
      </div>
    </Dialog>
  )
}
