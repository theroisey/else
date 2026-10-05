import { statusLabel } from '../../i18n/labels'
import { formatCalendarDate, formatDecimal } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { ClientNavigation } from '../clients/ClientNavigation'
import type { ReactNode } from 'react'
import { Button } from '../../components/ui'
import { APIError } from '../../services/authenticated'
import { money } from '../billing/money'
import { unscaled, utcToday } from './exact'
import { effective } from './models'
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
  useLocale()
  return (
    <div className="my-4 rounded-md border border-danger-line bg-danger-surface p-4">
      <p role="alert">
        {error instanceof APIError
          ? copy(error.message, 'pricing')
          : copy('Unable to load pricing. Try again.', 'pricing')}
      </p>
      <Button className="mt-3" onClick={retry}>
        {copy('Try again', 'pricing')}
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
  useLocale()
  const { clientID, permissions, client } = operation,
    context =
      permissions.clientView && !client.isError ? client.data : undefined
  return (
    <>
      <header className="page-header">
        <div className="min-w-0">
          <p className="eyebrow">
            {copy('{{value1}} · Pricing', 'pricing', {
              value1: context?.name ?? copy('Client workspace', 'common'),
            })}
          </p>
          <h1 className="page-title">{title}</h1>
          <p className="mt-2 text-xs text-muted">
            {copy(
              'Exact line totals · Retained agreements · Dates use the UTC calendar.',
              'pricing',
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </header>
      <ClientNavigation clientID={clientID} />
      {context?.status === 'archived' ? (
        <p role="status" className="mb-4">
          {copy(
            'This client is archived. Pricing history is retained; new changes are unavailable.',
            'pricing',
          )}
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
  useLocale()
  const state =
    v.window_until === v.effective_from
      ? copy('Superseded on its start date', 'pricing')
      : effective(v, utcToday())
        ? copy('Effective today', 'pricing')
        : v.effective_from > utcToday()
          ? copy('Future version', 'pricing')
          : copy('Historical version', 'pricing')
  return (
    <div className="text-xs leading-6 text-muted">
      <p>
        {copy('{{value1}} · Starts {{value2}}', 'pricing', {
          value1: state,
          value2: formatCalendarDate(v.effective_from),
        })}
      </p>
      <p>
        {copy(
          'Original end: {{value1}} · Effective window ends: {{value2}} (exclusive)',
          'pricing',
          {
            value1: v.effective_until
              ? formatCalendarDate(v.effective_until)
              : copy('Open ended', 'pricing'),
            value2: v.window_until
              ? formatCalendarDate(v.window_until)
              : copy('Open ended', 'pricing'),
          },
        )}
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
  useLocale()
  return (
    <section className="mt-4 form-section">
      <h2 className="font-semibold">{copy('Pricing breakdown', 'pricing')}</h2>
      <p className="mt-1 text-xs text-muted">
        {copy(
          'Discount precedes tax. Each line is rounded separately, then summed. Frequency describes the agreement; it does not schedule invoices.',
          'pricing',
        )}
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
              {copy(
                '{{kind}} · {{frequency}} · Quantity {{quantity}} × {{price}}',
                'pricing',
                {
                  kind: statusLabel(l.kind),
                  frequency: statusLabel(l.frequency),
                  quantity: formatDecimal(unscaled(l.quantity_micros, 6)),
                  price: money(l.unit_price_minor, c.currency),
                },
              )}
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
                        copy('Base', 'pricing'),
                        copy('Discount ({{value1}}%)', 'pricing', {
                          value1: formatDecimal(unscaled(l.discount_bps, 2)),
                        }),
                        copy('Net', 'pricing'),
                        copy('Tax ({{value1}}%)', 'pricing', {
                          value1: formatDecimal(unscaled(l.tax_bps, 2)),
                        }),
                        copy('Line total', 'pricing'),
                      ][i]
                    }
                  </dt>
                  <dd className="mt-1 break-words tabular-nums text-sm">
                    {money(l[f], c.currency)}
                  </dd>
                </div>
              ))}
            </dl>
            {manage ? (
              <p className="mt-3 text-xs text-muted">
                {copy(
                  'Internal unit cost:{{value1}} {{value2}}{{value3}} · Line cost:{{value4}} {{value5}}',
                  'pricing',
                  {
                    value1: ' ',
                    value2:
                      l.unit_cost_minor === undefined
                        ? copy('Unknown', 'pricing')
                        : money(l.unit_cost_minor, c.currency),
                    value3: ' ',
                    value4: ' ',
                    value5:
                      l.cost_minor === undefined
                        ? copy('Unknown', 'pricing')
                        : money(l.cost_minor, c.currency),
                  },
                )}
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
                  copy('Total base', 'pricing'),
                  copy('Total discount', 'pricing'),
                  copy('Total net', 'pricing'),
                  copy('Total tax', 'pricing'),
                  copy('Agreement total', 'pricing'),
                ][i]
              }
            </dt>
            <dd className="mt-1 break-words tabular-nums text-sm font-semibold">
              {money(c[f], c.currency)}
            </dd>
          </div>
        ))}
      </dl>
      {manage ? (
        <p className="mt-4 text-sm">
          {copy('Internal aggregate cost:{{value1}} {{value2}}', 'pricing', {
            value1: ' ',
            value2:
              c.cost_minor === undefined
                ? copy(
                    'Unknown — one or more line costs are unspecified.',
                    'pricing',
                  )
                : money(c.cost_minor, c.currency),
          })}
        </p>
      ) : null}
    </section>
  )
}
