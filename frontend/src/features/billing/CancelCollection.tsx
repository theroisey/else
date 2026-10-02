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
  return (
    <Dialog
      open
      title="Cancel collection?"
      description="This permanently closes the remaining obligation. Original amounts and all payment history are retained. Collected payments are not refunded. A cancelled collection cannot reopen or receive new payments."
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      <p className="mt-4 break-words text-sm">{record.description}</p>
      <p className="mt-2 text-sm">
        Outstanding obligation to close:{' '}
        {money(record.outstanding_minor, record.currency)}
      </p>
      {operation.error ? (
        <p role="alert" className="mt-3 text-danger-ink">
          {operation.error} Close this dialog and reload the collection before
          retrying.
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button disabled={operation.pending} onClick={onClose}>
          Keep collection
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
          Confirm cancellation
        </Button>
      </div>
    </Dialog>
  )
}
