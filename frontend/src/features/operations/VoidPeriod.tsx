import { useRef, useState } from 'react'
import { Button, Dialog, TextField } from '../../components/ui'
import { copy } from '../../i18n'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import type { Period } from './commercial-service'
import { write } from './commercial-service'
export function VoidPeriod({
  period,
  close,
}: {
  period: Period
  close: () => void
}) {
  const [baseline] = useState(period)
  const op = useRecordOperations('agreements', baseline.client_id)
  const [reason, setReason] = useState('')
  const [locked, setLocked] = useState(false)
  const sent = useRef<unknown>(null)
  const t = (s: string) => copy(s, 'operations')
  return (
    <Dialog
      open
      variant="drawer"
      title={t('Void unpaid period')}
      description={t(
        'Only periods without any payment or internal transfer history can be voided. Other corrections require retained reversals.',
      )}
      onClose={() => {
        if (
          !op.pending &&
          (!locked ||
            window.confirm(
              t(
                'Close this form and inspect the recorded history before starting another transaction?',
              ),
            ))
        )
          close()
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!sent.current) {
            sent.current = {
              command_id: crypto.randomUUID(),
              expected_revision: baseline.collection_revision,
              reason,
            }
            setLocked(true)
          }
          void op
            .run(
              () =>
                write(
                  baseline.client_id,
                  `commercial-periods/${baseline.id}/void`,
                  sent.current,
                ),
              (failure) => {
                if (failure instanceof APIError && failure.status === 400) {
                  sent.current = null
                  setLocked(false)
                }
              },
            )
            .then((v) => {
              if (v) close()
            })
        }}
      >
        <TextField
          label={t('Correction reason')}
          required
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={locked || op.pending}
        />
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
        <Button type="submit" variant="danger" disabled={op.pending}>
          {t(locked ? 'Retry original command' : 'Void unpaid period')}
        </Button>
      </form>
    </Dialog>
  )
}
