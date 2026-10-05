import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  if (
    record.status !== 'pending' ||
    !operation.permissions.update ||
    !operation.writable
  )
    return null
  const busy = operation.pending || !!operation.error
  return (
    <div className="flex flex-wrap gap-2">
      {!busy ? (
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={pagePath(operation.clientID, record.id) + '/edit'}
        >
          {copy('Edit reminder', 'reminders')}
        </Link>
      ) : null}
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          void operation
            .run(() =>
              api.finish(
                operation.clientID,
                record.id,
                'complete',
                record.revision,
              ),
            )
            .then((r) => {
              if (r) onSuccess('Reminder completed.')
            })
        }}
      >
        {copy('Complete', 'reminders')}
      </Button>
      <Button
        size="compact"
        disabled={busy}
        onClick={() => {
          operation.clearError()
          onDismiss(record)
        }}
      >
        {copy('Dismiss', 'reminders')}
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
  useLocale()
  return (
    <Dialog
      open
      title={copy('Dismiss {{value1}}?', 'reminders', { value1: record.title })}
      description={copy(
        'This reminder will leave the pending view. Its schedule and history are retained, and it cannot be reopened.',
        'reminders',
      )}
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {copy(operation.error, 'reminders') ? (
        <div>
          <p role="alert" className="text-danger-ink">
            {copy(operation.error, 'reminders')}
          </p>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Cancel and refresh before reviewing another attempt.',
              'reminders',
            )}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          {copy('Cancel', 'reminders')}
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          loadingLabel={copy('Dismissing reminder', 'reminders')}
          disabled={!!operation.error}
          onClick={() => {
            void operation
              .run(() =>
                api.finish(
                  operation.clientID,
                  record.id,
                  'dismiss',
                  record.revision,
                ),
              )
              .then((r) => {
                if (r) onSuccess()
              })
          }}
        >
          {copy('Confirm dismissal', 'reminders')}
        </Button>
      </div>
    </Dialog>
  )
}
