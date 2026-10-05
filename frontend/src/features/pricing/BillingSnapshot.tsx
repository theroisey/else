import { formatCalendarDate } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { Link } from 'react-router'
import { hasPermission } from '../auth/permissions'
import { BillingError } from '../billing/Shared'
import type { Operation } from '../billing/Shared'
import type { Collection } from '../billing/models'
import { Terms } from './Shared'
import { pagePath } from './models'
import { useBillingSnapshot } from './useBillingSnapshot'
export function BillingSnapshot({
  operation: op,
  record,
}: {
  operation: Operation
  record: Collection
}) {
  useLocale()
  const q = useBillingSnapshot(op, record)
  if (q.isPending)
    return (
      <p role="status" className="mt-4">
        {copy('Checking copied pricing terms…', 'pricing')}
      </p>
    )
  if (q.isError)
    return <BillingError error={q.error} retry={() => void q.refetch()} />
  if (!q.data) return null
  const s = q.data,
    view = hasPermission(op.auth.session?.user.permissions ?? [], {
      permission: 'pricing.view',
      scope: 'client',
      clientID: op.clientID,
    })
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">
        {copy('Copied pricing terms', 'pricing')}
      </h2>
      <p className="mt-2 break-words text-sm">
        {copy(
          '{{value1}} · Version {{value2}} · Billing date {{value3}} . These copied lines and the collection amount are fixed, including before the first payment.',
          'pricing',
          {
            value1: s.title,
            value2: s.pricing_revision,
            value3: formatCalendarDate(s.billing_date),
          },
        )}
      </p>
      {view ? (
        <Link
          className="mt-2 inline-block text-sm underline"
          to={pagePath(op.clientID, s.sheet_id) + '/versions/' + s.version_id}
        >
          {copy('Open retained pricing version', 'pricing')}
        </Link>
      ) : null}
      <Terms calculation={s} />
    </section>
  )
}
