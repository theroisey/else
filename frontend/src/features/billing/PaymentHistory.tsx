import { formatCalendarDate } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Table } from '../../components/ui'
import { formatTime } from '../../lib/time'
import { BillingError, Pager } from './Shared'
import type { Operation } from './Shared'
import type { Payment } from './models'
import { methodLabels } from './models'
import { money } from './money'
import * as api from './service'
function PaymentRow({ payment }: { payment: Payment }) {
  useLocale()
  const [revealed, setRevealed] = useState(false)
  return (
    <tr>
      <td className="whitespace-nowrap tabular-nums text-right text-[0.8125rem]">
        {money(payment.amount_minor, payment.currency)}
      </td>
      <td className="whitespace-nowrap text-xs">
        {formatCalendarDate(payment.paid_on)}
      </td>
      <td>{copy(methodLabels[payment.method], 'billing')}</td>
      <td className="min-w-48 max-w-80 break-words">
        {payment.reference ? (
          <>
            <span>
              {revealed
                ? payment.reference
                : copy('Reference hidden', 'billing')}
            </span>
            <Button
              size="compact"
              className="mt-2 block"
              onClick={() => setRevealed(!revealed)}
              aria-label={copy(
                '{{value1}} reference for payment {{value2}}',
                'billing',
                {
                  value1: revealed
                    ? copy('Hide', 'billing')
                    : copy('Reveal', 'billing'),
                  value2: payment.id,
                },
              )}
            >
              {revealed
                ? copy('Hide reference', 'billing')
                : copy('Reveal reference', 'billing')}
            </Button>
          </>
        ) : (
          <span className="text-muted">{copy('Not provided', 'billing')}</span>
        )}
      </td>
      <td className="min-w-48 max-w-80 whitespace-pre-wrap break-words">
        {payment.note || copy('Not provided', 'billing')}
      </td>
      <td className="min-w-48 text-xs">
        <time dateTime={payment.recorded_at}>
          {formatTime(payment.recorded_at)}
        </time>
        <span className="mt-1 block break-all text-muted">
          {copy('Recorded by {{value1}}', 'billing', {
            value1: payment.recorded_by,
          })}
        </span>
      </td>
    </tr>
  )
}
export function PaymentHistory({
  operation,
  id,
}: {
  operation: Operation
  id: string
}) {
  useLocale()
  const [history, setHistory] = useState([''])
  const query = useQuery({
    queryKey: [...operation.key, 'payments', id, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() =>
        api.payments(operation.clientID, id, history.at(-1) ?? '', signal),
      ),
    enabled: operation.permissions.view,
  })
  return (
    <section className="mt-6" aria-label={copy('Payment history', 'billing')}>
      <h2 className="mb-3 font-semibold">
        {copy('Payment history', 'billing')}
      </h2>
      <p className="mb-3 text-xs text-muted">
        {copy(
          'Permanent records in ID order. Payment dates use the UTC calendar; recorded times use your device timezone. References stay hidden until revealed.',
          'billing',
        )}
      </p>
      {query.isPending ? (
        <p role="status" aria-busy="true">
          {copy('Loading payment history…', 'billing')}
        </p>
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.data.length ? (
        <p className="form-section text-sm">
          {copy('No payments recorded on this page.', 'billing')}
        </p>
      ) : (
        <Table caption={copy('Collection payments', 'billing')}>
          <thead>
            <tr>
              {[
                copy('Amount', 'billing'),
                copy('Payment date', 'billing'),
                copy('Method', 'billing'),
                copy('Reference', 'billing'),
                copy('Note', 'billing'),
                copy('Recorded', 'billing'),
              ].map((v) => (
                <th
                  className={v === 'Amount' ? 'text-right' : ''}
                  key={v}
                  scope="col"
                >
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((p) => (
              <PaymentRow
                key={
                  JSON.stringify(operation.key) +
                  ':' +
                  history.at(-1) +
                  ':' +
                  p.id
                }
                payment={p}
              />
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        name={copy('Payments', 'billing')}
        history={history}
        next={query.isError ? null : query.data?.page.next_cursor}
        busy={query.isFetching}
        onChange={setHistory}
      />
    </section>
  )
}
