import { copy, useLocale } from '../../i18n/index'
import { Button, Dialog } from '../../components/ui'
import type { Collection } from './models'
import type { Operation } from './Shared'
import { money } from './money'
import * as api from './service'
export function CancelCollection({
  record,
  operation,
  onClose,
  onSuccess,
}: {
  record: Collection
  operation: Operation
  onClose: () => void
  onSuccess: () => void
}) {
  useLocale()
  return (
    <Dialog
      open
      title={copy('Cancel collection?', 'billing')}
      description={copy(
        'This permanently closes the remaining obligation. Original amounts and all payment history are retained. Collected payments are not refunded. A cancelled collection cannot reopen or receive new payments.',
        'billing',
      )}
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      <p className="mt-4 break-words text-sm">{record.description}</p>
      <p className="mt-2 text-sm">
        {copy(
          'Outstanding obligation to close:{{value1}} {{value2}}',
          'billing',
          {
            value1: ' ',
            value2: money(record.outstanding_minor, record.currency),
          },
        )}
      </p>
      {copy(operation.error, 'billing') ? (
        <p role="alert" className="mt-3 text-danger-ink">
          {copy(
            '{{value1}} Close this dialog and reload the collection before retrying.',
            'billing',
            { value1: operation.error },
          )}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          {copy('Keep collection', 'billing')}
        </Button>
        <Button
          variant="danger"
          loading={operation.pending}
          disabled={!operation.writable || !!operation.error}
          onClick={() =>
            void operation
              .run(() =>
                api.cancel(operation.clientID, record.id, record.revision),
              )
              .then((r) => {
                if (r) onSuccess()
              })
          }
        >
          {copy('Confirm cancellation', 'billing')}
        </Button>
      </div>
    </Dialog>
  )
}
