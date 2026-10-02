import { Link } from 'react-router'
import { money } from '../billing/money'
import type { Overview } from './models'

export function FinancialPosition({
  finance,
  base,
}: {
  finance: NonNullable<Overview['finance']>
  base: string
}) {
  return (
    <section
      aria-labelledby="finance-title"
      className="border-t border-line pt-6 xl:border-t-0 xl:pt-0"
    >
      <h2 id="finance-title" className="text-lg font-semibold">
        Financial position
      </h2>
      <p className="mt-2 text-xs leading-5 text-muted">
        All client collections, grouped by currency. Cancelled obligations and
        their retained payments remain separate.
      </p>
      {!finance.currencies.length ? (
        <p className="mt-4 text-sm text-muted">No balances recorded yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-line">
          {finance.currencies.map((row) => (
            <section
              aria-label={`${row.currency} financial position`}
              key={row.currency}
              className="py-4"
            >
              <h3 className="text-sm font-semibold">{row.currency}</h3>
              <dl className="mt-3 space-y-2">
                {(
                  [
                    ['Outstanding', 'outstanding_minor'],
                    ['Overdue', 'overdue_minor'],
                    ['Collected', 'paid_minor'],
                    ['Active obligations', 'amount_minor'],
                    ['Cancelled obligations', 'cancelled_amount_minor'],
                    ['Retained cancelled payments', 'cancelled_paid_minor'],
                  ] as const
                ).map(([label, field]) => (
                  <div
                    key={field}
                    className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                  >
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd
                      className={`min-w-0 break-all font-mono ${field === 'outstanding_minor' ? 'text-lg font-semibold' : 'text-sm'}`}
                    >
                      {money(row[field], row.currency, row.currency_exponent)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
      <Link
        className="mt-3 inline-block text-sm underline underline-offset-4"
        to={`${base}/billing`}
      >
        Open finance
      </Link>
    </section>
  )
}
