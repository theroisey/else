import { copy, useLocale } from '../../i18n/index'
import { useQuery } from '@tanstack/react-query'
import { Table } from '../../components/ui'
import { BillingError } from './Shared'
import type { Operation } from './Shared'
import { money } from './money'
import * as api from './service'
export function FinanceSummary({ operation }: { operation: Operation }) {
  useLocale()
  const query = useQuery({
    queryKey: [...operation.key, 'summary'],
    queryFn: ({ signal }) =>
      operation.read(() => api.summary(operation.clientID, signal)),
    enabled: operation.permissions.view,
  })
  return (
    <section aria-label={copy('Currency balances', 'billing')} className="mb-6">
      <h2 className="mb-3 font-semibold">
        {copy('Balances by currency', 'billing')}
      </h2>
      <p className="mb-3 text-xs text-muted">
        {copy(
          'All collections for this client, independent of table filters. Cancelled obligations and their retained payments are shown separately.',
          'billing',
        )}
      </p>
      {query.isPending ? (
        <p role="status" aria-busy="true">
          {copy('Loading balances…', 'billing')}
        </p>
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.length ? (
        <p className="form-section text-sm">
          {copy('No balances recorded yet.', 'billing')}
        </p>
      ) : (
        <Table caption={copy('Balances by currency', 'billing')}>
          <thead>
            <tr>
              {[
                copy('Currency', 'billing'),
                copy('Active obligations', 'billing'),
                copy('Collected', 'billing'),
                copy('Outstanding', 'billing'),
                copy('Overdue', 'billing'),
                copy('Cancelled obligations', 'billing'),
                copy('Retained cancelled payments', 'billing'),
              ].map((v) => (
                <th
                  scope="col"
                  className={v === 'Currency' ? '' : 'text-right'}
                  key={v}
                >
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
                    className={`whitespace-nowrap tabular-nums text-right ${field === 'outstanding_minor' ? 'font-display text-2xl' : 'text-[0.8125rem]'}`}
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
