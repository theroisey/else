import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Dialog, TextField, SelectField } from '../../components/ui'
import { copy } from '../../i18n'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import type { Currency } from '../billing/money'
import { money, toMinor } from '../billing/money'
import * as billing from '../billing/service'
import * as api from './commercial-service'
import { OperationsError } from './Shared'
import { localDate } from './preferences-service'
interface Reference {
  id: string
  client_id: string
  currency: Currency
  revision: string
}
export function RefundForm({
  record,
  close,
}: {
  record: Reference
  close: () => void
}) {
  const [baseline] = useState(record)
  const op = useRecordOperations('billing', baseline.client_id)
  const [amount, setAmount] = useState(''),
    [payment, setPayment] = useState(''),
    [reason, setReason] = useState(''),
    [date, setDate] = useState(() => localDate('UTC')),
    [cursor, setCursor] = useState(''),
    [locked, setLocked] = useState(false),
    [error, setError] = useState('')
  const sent = useRef<{ path: string; body: unknown } | null>(null)
  const t = (s: string) => copy(s, 'operations')
  const q = useQuery({
    queryKey: [...op.key, 'refund-payments', baseline.id, cursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        billing.payments(baseline.client_id, baseline.id, cursor, signal),
      ),
  })
  return (
    <Dialog
      open
      variant="drawer"
      title={t('Record refund')}
      description={t(
        'The original payment remains. A refund reduces the customer collection and recalculates any linked internal balance.',
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
          setError('')
          if (!sent.current) {
            const minor = toMinor(amount, baseline.currency)
            if (!minor || minor === '0' || !payment || !reason.trim()) {
              setError(t('Check the original payment, amount and reason.'))
              return
            }
            sent.current = {
              path: `payments/${payment}/reverse`,
              body: {
                command_id: crypto.randomUUID(),
                expected_revision: baseline.revision,
                amount_minor: minor,
                currency: baseline.currency,
                reversed_on: date,
                reason,
              },
            }
            setLocked(true)
          }
          const original = sent.current
          void op
            .run(
              () =>
                api.paymentMutation(
                  baseline.client_id,
                  baseline.id,
                  original.path,
                  original.body,
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
        <fieldset disabled={op.pending || locked} className="space-y-4">
          <SelectField
            required
            label={t('Original payment')}
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
          >
            <option value="">{t('Choose original payment')}</option>
            {payment && !q.data?.data.some((v) => v.id === payment) ? (
              <option value={payment}>{t('Selected original payment')}</option>
            ) : null}
            {q.data?.data.map((v) => (
              <option key={v.id} value={v.id}>
                {v.paid_on} · {money(v.amount_minor, v.currency)}
              </option>
            ))}
          </SelectField>
          {cursor ? (
            <Button variant="text" onClick={() => setCursor('')}>
              {t('First page')}
            </Button>
          ) : null}
          {q.data?.page.next_cursor ? (
            <Button
              variant="text"
              onClick={() => setCursor(q.data.page.next_cursor!)}
            >
              {t('Next page')}
            </Button>
          ) : null}
          <TextField
            label={t('Amount')}
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="text-xs text-muted">{baseline.currency}</p>
          <TextField
            label={t('Refund date (UTC)')}
            required
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextField
            label={t('Refund reason')}
            required
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </fieldset>
        {q.isError ? (
          <OperationsError
            error={q.error}
            retry={() => {
              void q.refetch()
            }}
          />
        ) : null}
        {error || op.error ? (
          <p role="alert" className="text-danger-ink">
            {error || copy(op.error)}
          </p>
        ) : null}
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
        <Button variant="primary" type="submit" disabled={op.pending}>
          {t(locked ? 'Retry original command' : 'Save')}
        </Button>
      </form>
    </Dialog>
  )
}
export function RefundHistory({ client, id }: { client: string; id: string }) {
  const op = useRecordOperations('billing', client)
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState('')
  const t = (s: string) => copy(s, 'operations')
  const q = useQuery({
    queryKey: [...op.key, 'refund-history', id, cursor],
    enabled: open,
    queryFn: ({ signal }) =>
      op.read(() => api.reversals(client, id, cursor, signal)),
  })
  return (
    <details
      className="mt-6 border-t border-line py-5"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t('Refund history')}
      </summary>
      {open ? (
        q.isError ? (
          <OperationsError
            error={q.error}
            retry={() => {
              void q.refetch()
            }}
          />
        ) : q.isPending ? (
          <p className="mt-4 text-sm text-muted">{t('Loading finance…')}</p>
        ) : (
          <>
            <ul>
              {q.data.data.map((v) => (
                <li key={v.id} className="border-b border-line py-4 text-sm">
                  <p>
                    {v.reversed_on} · {money(v.amount_minor, v.currency)}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-muted">
                    {v.reason}
                  </p>
                </li>
              ))}
            </ul>
            {!q.data.data.length ? (
              <p className="mt-4 text-sm text-muted">
                {t('No refunds recorded.')}
              </p>
            ) : null}
            {cursor ? (
              <Button className="mt-4" onClick={() => setCursor('')}>
                {t('First page')}
              </Button>
            ) : null}
            {q.data.page.next_cursor ? (
              <Button
                className="mt-4"
                onClick={() => setCursor(q.data.page.next_cursor!)}
              >
                {t('Next page')}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </details>
  )
}
