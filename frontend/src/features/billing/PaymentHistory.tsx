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
  const [revealed, setRevealed] = useState(false)
  return (
    <tr>
      <td className="whitespace-nowrap font-mono text-xs">
        {money(payment.amount_minor, payment.currency)}
      </td>
      <td className="whitespace-nowrap text-xs">{payment.paid_on}</td>
      <td>{methodLabels[payment.method]}</td>
      <td className="min-w-48 max-w-80 break-words">
        {payment.reference ? (
          <>
            <span>{revealed ? payment.reference : 'Reference hidden'}</span>
            <Button
              size="compact"
              className="mt-2 block"
              onClick={() => setRevealed(!revealed)}
              aria-label={`${revealed ? 'Hide' : 'Reveal'} reference for payment ${payment.id}`}
            >
              {revealed ? 'Hide reference' : 'Reveal reference'}
            </Button>
          </>
        ) : (
          <span className="text-muted">Not provided</span>
        )}
      </td>
      <td className="min-w-48 max-w-80 whitespace-pre-wrap break-words">
        {payment.note || 'Not provided'}
      </td>
      <td className="min-w-48 text-xs">
        <time dateTime={payment.recorded_at}>
          {formatTime(payment.recorded_at)}
        </time>
        <span className="mt-1 block break-all text-muted">
          Recorded by {payment.recorded_by}
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
    <section className="mt-6" aria-label="Payment history">
      <h2 className="mb-3 font-semibold">Payment history</h2>
      <p className="mb-3 text-xs text-muted">
        Permanent records in ID order. Payment dates use the UTC calendar;
        recorded times use your device timezone. References stay hidden until
        revealed.
      </p>
      {query.isPending ? (
        <p role="status" aria-busy="true">
          Loading payment history…
        </p>
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.data.length ? (
        <p className="rounded-md border border-line bg-surface p-4 text-sm">
          No payments recorded on this page.
        </p>
      ) : (
        <Table caption="Collection payments">
          <thead>
            <tr>
              {[
                'Amount',
                'Payment date',
                'Method',
                'Reference',
                'Note',
                'Recorded',
              ].map((v) => (
                <th key={v} scope="col">
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
        name="Payments"
        history={history}
        next={query.isError ? null : query.data?.page.next_cursor}
        busy={query.isFetching}
        onChange={setHistory}
      />
    </section>
  )
}
