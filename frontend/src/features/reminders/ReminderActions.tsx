import { Link } from 'react-router'
import { Button, Dialog, buttonStyles } from '../../components/ui'
import { pagePath } from './models'
import type { Summary } from './models'
import type { Operation } from './Shared'
import * as api from './service'
export function ReminderActions({
  record,
  operation,
  onDismiss,
  onSuccess,
}: {
  record: Summary
  operation: Operation
  onDismiss: (r: Summary) => void
  onSuccess: (message: string) => void
}) {
  if (record.status !== 'pending' || !operation.permissions.update || !operation.writable)
    return null
  const busy = operation.pending || !!operation.error
  return (
    <div className="flex flex-wrap gap-2">
      {!busy ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={pagePath(operation.clientID, record.id) + '/edit'}
        >
          Edit reminder
        </Link>
      ) : null}
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          void operation
            .run(() => api.finish(operation.clientID, record.id, 'complete', record.revision))
            .then((r) => {
              if (r) onSuccess('Reminder completed.')
            })
        }}
      >
        Complete
      </Button>
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          operation.clearError()
          onDismiss(record)
        }}
      >
        Dismiss
      </Button>
    </div>
  )
}
export function ReminderDismiss({
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
      title={`Dismiss ${record.title}?`}
      description="This reminder will leave the pending view. Its schedule and history are retained, and it cannot be reopened."
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
          loadingLabel="Dismissing reminder"
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() => api.finish(operation.clientID, record.id, 'dismiss', record.revision))
              .then((r) => {
                if (r) onSuccess()
              })
          }}
        >
          Confirm dismissal
        </Button>
      </div>
    </Dialog>
  )
}
