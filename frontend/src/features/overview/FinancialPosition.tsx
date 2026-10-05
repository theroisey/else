import { Link } from 'react-router'
import { money } from '../billing/money'
import type { Overview } from './models'

export function FinancialPosition({ finance, base }: { finance: NonNullable<Overview['finance']>; base: string }) {
  return <section aria-labelledby="finance-title" className="financial-position">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 id="finance-title" className="eyebrow">Financial position</h2><Link className="text-xs underline underline-offset-4" to={`${base}/billing`}>Open finance</Link></div>
    <p className="mt-2 text-xs leading-5 text-muted">All client collections, grouped by currency. Cancelled obligations and their retained payments remain separate.</p>
    {!finance.currencies.length ? <p className="mt-6 text-sm text-muted">No balances recorded yet.</p> : <div className="mt-5 divide-y divide-line">{finance.currencies.map(row => <section aria-label={`${row.currency} financial position`} key={row.currency} className="financial-currency">
      <div className="financial-lead"><p className="mb-2 text-xs text-muted">Outstanding · {row.currency}</p><p className="financial-value">{money(row.outstanding_minor, row.currency, row.currency_exponent)}</p></div>
      <dl className="financial-details">{([['Collected', 'paid_minor'], ['Overdue', 'overdue_minor'], ['Active obligations', 'amount_minor'], ['Cancelled obligations', 'cancelled_amount_minor'], ['Retained cancelled payments', 'cancelled_paid_minor']] as const).map(([label, field]) => <div key={field}><dt className="text-[0.625rem] leading-5 text-muted">{label}</dt><dd className={`mt-1 break-all text-sm font-medium tabular-nums ${field === 'overdue_minor' && BigInt(row[field]) > 0n ? 'text-danger-ink' : ''}`}>{money(row[field], row.currency, row.currency_exponent)}</dd></div>)}</dl>
    </section>)}</div>}
  </section>
}
