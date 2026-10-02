import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button, buttonStyles } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { money } from '../billing/money'
import { unscaled, utcToday } from './exact'
import { pagePath, effective } from './models'
import type { Calculation, Version } from './models'
import type { usePricing } from './hooks'
export { Pager } from '../planning/Shared'
export type Operation = ReturnType<typeof usePricing>
export function PricingError({
  error,
  retry,
}: {
  error: unknown
  retry: () => void
}) {
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? error.message
          : 'Unable to load pricing. Try again.'}
      </p>
      <Button className="mt-3" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}
export function PricingHeader({
  title,
  operation,
  children,
}: {
  title: string
  operation: Operation
  children?: ReactNode
}) {
  const { clientID, permissions, client } = operation,
    context =
      permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">
            {context?.name ?? 'Client workspace'} · Pricing
          </p>
          <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-2 text-xs text-muted">
            Exact line totals · Retained agreements · Dates use the UTC
            calendar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <nav
        aria-label="Client modules"
        className="mb-5 flex flex-wrap gap-2 border-b border-line pb-4"
      >
        {context ? (
          <Link
            className={buttonStyles({ size: 'compact' })}
            to={`/app/clients/${clientID}`}
          >
            Overview
          </Link>
        ) : null}
        <Link
          className={buttonStyles({ size: 'compact' })}
          to={pagePath(clientID)}
        >
          Pricing
        </Link>
        {permissions.billingView ? (
          <Link
            className={buttonStyles({ size: 'compact' })}
            to={`/app/clients/${clientID}/billing`}
          >
            Finance
          </Link>
        ) : null}
      </nav>
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          This client is archived. Pricing history is retained; new changes are
          unavailable.
        </p>
      ) : null}
      {permissions.clientView && client.isError ? (
        <PricingError
          error={client.error}
          retry={() => void client.refetch()}
        />
      ) : null}
    </>
  )
}
export function Window({ version: v }: { version: Version }) {
  const state =
    v.window_until === v.effective_from
      ? 'Superseded on its start date'
      : effective(v, utcToday())
        ? 'Effective today'
        : v.effective_from > utcToday()
          ? 'Future version'
          : 'Historical version'
  return (
    <div className="text-xs leading-6 text-muted">
      <p>
        {state} · Starts {v.effective_from}
      </p>
      <p>
        Original end: {v.effective_until ?? 'Open ended'} · Effective window
        ends: {v.window_until ?? 'Open ended'} (exclusive)
      </p>
    </div>
  )
}
export function Terms({
  calculation: c,
  manage = false,
}: {
  calculation: Calculation
  manage?: boolean
}) {
  return (
    <section className="mt-4 rounded-md border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-semibold">Pricing breakdown</h2>
      <p className="mt-1 text-xs text-muted">
        Discount precedes tax. Each line is rounded separately, then summed.
        Frequency describes the agreement; it does not schedule invoices.
      </p>
      <ol className="mt-4 grid gap-3">
        {c.lines.map((l) => (
          <li
            key={l.position}
            className="min-w-0 rounded-sm border border-line p-3"
          >
            <h3 className="break-words font-semibold">
              {l.position}. {l.description}
            </h3>
            <p className="mt-1 text-xs text-muted">
              {l.kind.replace('_', ' ')} · {l.frequency} · Quantity{' '}
              {unscaled(l.quantity_micros, 6)} ×{' '}
              {money(l.unit_price_minor, c.currency)}
            </p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {(
                [
                  'base_minor',
                  'discount_minor',
                  'net_minor',
                  'tax_minor',
                  'total_minor',
                ] as const
              ).map((f, i) => (
                <div key={f}>
                  <dt className="text-xs text-muted">
                    {
                      [
                        'Base',
                        `Discount (${unscaled(l.discount_bps, 2)}%)`,
                        'Net',
                        `Tax (${unscaled(l.tax_bps, 2)}%)`,
                        'Line total',
                      ][i]
                    }
                  </dt>
                  <dd className="mt-1 break-words font-mono text-xs">
                    {money(l[f], c.currency)}
                  </dd>
                </div>
              ))}
            </dl>
            {manage ? (
              <p className="mt-3 text-xs text-muted">
                Internal unit cost:{' '}
                {l.unit_cost_minor === undefined
                  ? 'Unknown'
                  : money(l.unit_cost_minor, c.currency)}{' '}
                · Line cost:{' '}
                {l.cost_minor === undefined
                  ? 'Unknown'
                  : money(l.cost_minor, c.currency)}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <dl className="mt-5 grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {(
          [
            'base_minor',
            'discount_minor',
            'net_minor',
            'tax_minor',
            'total_minor',
          ] as const
        ).map((f, i) => (
          <div key={f}>
            <dt className="text-xs text-muted">
              {
                [
                  'Total base',
                  'Total discount',
                  'Total net',
                  'Total tax',
                  'Agreement total',
                ][i]
              }
            </dt>
            <dd className="mt-1 break-words font-mono text-sm font-semibold">
              {money(c[f], c.currency)}
            </dd>
          </div>
        ))}
      </dl>
      {manage ? (
        <p className="mt-4 text-sm">
          Internal aggregate cost:{' '}
          {c.cost_minor === undefined
            ? 'Unknown — one or more line costs are unspecified.'
            : money(c.cost_minor, c.currency)}
        </p>
      ) : null}
    </section>
  )
}
