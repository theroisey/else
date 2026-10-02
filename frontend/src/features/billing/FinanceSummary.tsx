import { useQuery } from '@tanstack/react-query'
import { Table } from '../../components/ui'
import { BillingError } from './Shared'
import type { Operation } from './Shared'
import { money } from './money'
import * as api from './service'
export function FinanceSummary({ operation }: { operation: Operation }) {
  const query = useQuery({
    queryKey: [...operation.key, 'summary'],
    queryFn: ({ signal }) =>
      operation.read(() => api.summary(operation.clientID, signal)),
    enabled: operation.permissions.view,
  })
  return (
    <section aria-label="Currency balances" className="mb-6">
      <h2 className="mb-3 font-semibold">Balances by currency</h2>
      <p className="mb-3 text-xs text-muted">
        All collections for this client, independent of table filters. Cancelled
        obligations and their retained payments are shown separately.
      </p>
      {query.isPending ? (
        <p role="status" aria-busy="true">
          Loading balances…
        </p>
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.length ? (
        <p className="rounded-md border border-line bg-surface p-4 text-sm">
          No balances recorded yet.
        </p>
      ) : (
        <Table caption="Balances by currency">
          <thead>
            <tr>
              {[
                'Currency',
                'Active obligations',
                'Collected',
                'Outstanding',
                'Overdue',
                'Cancelled obligations',
                'Retained cancelled payments',
              ].map((v) => (
                <th scope="col" key={v}>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data.map((t) => (
              <tr key={t.currency}>
                <th scope="row">{t.currency}</th>
                {(
                  [
                    'amount_minor',
                    'paid_minor',
                    'outstanding_minor',
                    'overdue_minor',
                    'cancelled_amount_minor',
                    'cancelled_paid_minor',
                  ] as const
                ).map((field) => (
                  <td
                    key={field}
                    className="whitespace-nowrap font-mono text-xs"
                  >
                    {money(t[field], t.currency, t.currency_exponent)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
