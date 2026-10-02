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
  const q = useBillingSnapshot(op, record)
  if (q.isPending)
    return (
      <p role="status" className="mt-4">
        Checking copied pricing terms…
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
      <h2 className="text-lg font-semibold">Copied pricing terms</h2>
      <p className="mt-2 break-words text-sm">
        {s.title} · Version {s.pricing_revision} · Billing date {s.billing_date}
        . These copied lines and the collection amount are fixed, including
        before the first payment.
      </p>
      {view ? (
        <Link
          className="mt-2 inline-block text-sm underline"
          to={pagePath(op.clientID, s.sheet_id) + '/versions/' + s.version_id}
        >
          Open retained pricing version
        </Link>
      ) : null}
      <Terms calculation={s} />
    </section>
  )
}
