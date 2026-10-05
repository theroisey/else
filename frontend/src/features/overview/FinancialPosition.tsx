import { copy, useLocale } from '../../i18n/index'
import { Link } from 'react-router'
import { money } from '../billing/money'
import type { Currency } from '../billing/money'
import type { Overview } from './models'

function FinancialAmount({
  minor,
  currency,
  exponent,
}: {
  minor: string
  currency: Currency
  exponent: number
}) {
  const value = money(minor, currency, exponent)
  const position = value.indexOf(currency)
  return (
    <>
      {value.slice(0, position)}
      <wbr />
      <span className="inline-block whitespace-nowrap">{currency}</span>
      <wbr />
      {value.slice(position + currency.length)}
    </>
  )
}

export function FinancialPosition({
  finance,
  base,
}: {
  finance: NonNullable<Overview['finance']>
  base: string
}) {
  useLocale()
  return (
    <section aria-labelledby="finance-title" className="financial-position">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="finance-title" className="eyebrow">
          {copy('Financial position', 'overview')}
        </h2>
        <Link
          className="text-xs underline underline-offset-4"
          to={`${base}/billing`}
        >
          {copy('Open finance', 'overview')}
        </Link>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">
        {copy(
          'All client collections, grouped by currency. Cancelled obligations and their retained payments remain separate.',
          'overview',
        )}
      </p>
      {!finance.currencies.length ? (
        <p className="mt-6 text-sm text-muted">
          {copy('No balances recorded yet.', 'overview')}
        </p>
      ) : (
        <div className="mt-5 divide-y divide-line">
          {finance.currencies.map((row) => (
            <section
              aria-label={copy('{{value1}} financial position', 'overview', {
                value1: row.currency,
              })}
              key={row.currency}
              className="financial-currency"
            >
              <div className="financial-lead">
                <p className="mb-2 text-xs text-muted">
                  {copy('Outstanding · {{value1}}', 'overview', {
                    value1: row.currency,
                  })}
                </p>
                <p className="financial-value">
                  <FinancialAmount
                    minor={row.outstanding_minor}
                    currency={row.currency}
                    exponent={row.currency_exponent}
                  />
                </p>
              </div>
              <dl className="financial-details">
                {(
                  [
                    [copy('Collected', 'overview'), 'paid_minor'],
                    [copy('Overdue', 'overview'), 'overdue_minor'],
                    [copy('Active obligations', 'overview'), 'amount_minor'],
                    [
                      copy('Cancelled obligations', 'overview'),
                      'cancelled_amount_minor',
                    ],
                    [
                      copy('Retained cancelled payments', 'overview'),
                      'cancelled_paid_minor',
                    ],
                  ] as const
                ).map(([label, field]) => (
                  <div key={field}>
                    <dt className="text-[0.625rem] leading-5 text-muted">
                      {label}
                    </dt>
                    <dd
                      className={`mt-1 break-all text-sm font-medium tabular-nums ${field === 'overdue_minor' && BigInt(row[field]) > 0n ? 'text-danger-ink' : ''}`}
                    >
                      <FinancialAmount
                        minor={row[field]}
                        currency={row.currency}
                        exponent={row.currency_exponent}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
