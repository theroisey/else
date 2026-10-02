import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useBilling } from './hooks'
import { BillingHeader, BillingState, BillingError } from './Shared'
import { pagePath } from './models'
import { money } from './money'
import { PaymentForm } from './PaymentForm'
import { PaymentHistory } from './PaymentHistory'
import { CancelCollection } from './CancelCollection'
import { BillingSnapshot } from '../pricing/BillingSnapshot'
import * as api from './service'
export function BillingDetailPage() {
  const { id = '', collectionID = '' } = useParams()
  return (
    <Detail
      key={id + ':' + collectionID}
      clientID={id}
      recordID={collectionID}
    />
  )
}
function Detail({
  clientID,
  recordID,
}: {
  clientID: string
  recordID: string
}) {
  const operation = useBilling(clientID),
    [confirm, setConfirm] = useState(false),
    [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: [...operation.key, 'detail', recordID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, recordID, signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  const r = query.isError ? undefined : query.data,
    busy = query.isFetching || operation.pending
  function reload() {
    operation.clearError()
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  return (
    <section>
      <BillingHeader title="Collection details" operation={operation}>
        <Button disabled={busy} onClick={reload}>
          Refresh collection
        </Button>
        {r &&
        operation.permissions.update &&
        operation.writable &&
        r.status !== 'cancelled' ? (
          <Link
            className={buttonStyles()}
            to={pagePath(clientID, r.id) + '/edit'}
          >
            Edit collection
          </Link>
        ) : null}
      </BillingHeader>
      {notice ? (
        <p role="status" className="mb-4">
          {notice}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" aria-busy="true">
          Loading collection…
        </p>
      ) : query.isError ? (
        <BillingError error={query.error} retry={reload} />
      ) : r ? (
        <>
          <article className="rounded-md border border-line bg-surface p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="max-w-3xl whitespace-pre-wrap break-words text-lg font-semibold">
                {r.description}
              </h2>
              <BillingState record={r} />
            </div>
            <dl className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {(
                ['amount_minor', 'paid_minor', 'outstanding_minor'] as const
              ).map((field, i) => (
                <div key={field}>
                  <dt className="text-xs text-muted">
                    {['Amount', 'Collected', 'Outstanding'][i]}
                  </dt>
                  <dd className="mt-1 break-words font-mono text-sm">
                    {money(r[field], r.currency, r.currency_exponent)}
                  </dd>
                </div>
              ))}
              <div>
                <dt className="text-xs text-muted">Due date (UTC calendar)</dt>
                <dd className="mt-1 text-sm">{r.due_date ?? 'Not set'}</dd>
              </div>
            </dl>
            <h3 className="mt-5 text-sm font-semibold">Internal note</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted">
              {r.internal_note || 'Not provided'}
            </p>
            {r.cancelled_at ? (
              <p className="mt-4 text-sm">
                Remaining obligation closed. Retained payments remain in
                history.
              </p>
            ) : null}
          </article>
          <BillingSnapshot operation={operation} record={r} />
          {operation.permissions.cancel &&
          operation.writable &&
          !['cancelled', 'paid'].includes(r.status) ? (
            <Button
              variant="danger"
              className="mt-4"
              disabled={busy}
              onClick={() => {
                operation.clearError()
                setConfirm(true)
              }}
            >
              Cancel collection
            </Button>
          ) : null}
          {operation.permissions.update &&
          !['cancelled', 'paid'].includes(r.status) ? (
            <PaymentForm
              key={JSON.stringify(operation.key) + ':' + r.revision}
              record={r}
              operation={operation}
              checking={busy}
            />
          ) : null}
          <PaymentHistory
            key={JSON.stringify(operation.key) + ':' + recordID}
            operation={operation}
            id={recordID}
          />
          {confirm && operation.permissions.cancel && operation.writable ? (
            <CancelCollection
              record={r}
              operation={operation}
              onClose={() => setConfirm(false)}
              onSuccess={() => {
                setConfirm(false)
                setNotice('Collection cancelled. Payment history retained.')
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
