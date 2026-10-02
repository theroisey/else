import { Link, useNavigate, useParams } from 'react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useBilling } from './hooks'
import { BillingHeader, BillingError } from './Shared'
import type { Operation } from './Shared'
import { profileSchema, pagePath } from './models'
import type { Collection } from './models'
import type { Currency } from './money'
import { toMinor, decimal } from './money'
import * as api from './service'
import { useBillingSnapshot } from '../pricing/useBillingSnapshot'
interface Draft {
  description: string
  internal_note: string
  amount: string
  currency: Currency | ''
  due_date: string
}
const draftOf = (r?: Collection): Draft => ({
  description: r?.description ?? '',
  internal_note: r?.internal_note ?? '',
  amount: r ? decimal(r.amount_minor, r.currency_exponent) : '',
  currency: r?.currency ?? '',
  due_date: r?.due_date ?? '',
})
export function BillingEditorPage({ create = false }: { create?: boolean }) {
  const { id = '', collectionID = '' } = useParams()
  return (
    <Editor
      key={id + ':' + collectionID + ':' + create}
      clientID={id}
      recordID={collectionID}
      create={create}
    />
  )
}
function Editor({
  clientID,
  recordID,
  create,
}: {
  clientID: string
  recordID: string
  create: boolean
}) {
  const operation = useBilling(clientID),
    allowed = create
      ? operation.permissions.create
      : operation.permissions.update
  const query = useQuery({
    queryKey: [...operation.key, 'detail', recordID],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, recordID, signal)),
    enabled: allowed && !create,
  })
  const snapshot = useBillingSnapshot(operation, create || query.isError ? undefined : query.data)
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <BillingHeader
        title={create ? 'Create collection' : 'Edit collection'}
        operation={operation}
      />
      {!create && query.data && snapshot.isPending ? <p role="status">Checking collection price origin…</p> : null}
      {!create && snapshot.isError ? <BillingError error={snapshot.error} retry={() => void snapshot.refetch()} /> : null}
      {!create && query.isPending ? (
        <p role="status" aria-busy="true">
          Loading collection…
        </p>
      ) : !create && query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : create || query.data ? (
        <CollectionForm
          key={
            JSON.stringify(operation.key) +
            ':' +
            (query.data?.revision ?? 'new')
          }
          operation={operation}
          record={create ? undefined : query.data}
          checking={!create && query.isFetching}
          copied={snapshot.data !== null || snapshot.isError || snapshot.isFetching}
        />
      ) : null}
    </section>
  )
}
function CollectionForm({
  operation,
  record,
  checking,
  copied,
}: {
  operation: Operation
  record?: Collection | undefined
  checking: boolean
  copied: boolean
}) {
  const navigate = useNavigate(),
    [localError, setLocalError] = useState(''),
    [requiresReload, setRequiresReload] = useState(false)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Draft>({ defaultValues: draftOf(record) })
  const catalog = useQuery({
    queryKey: [...operation.key, 'currencies'],
    queryFn: ({ signal }) =>
      operation.read(() => api.currencyCatalog(operation.clientID, signal)),
    enabled: operation.permissions.view,
  })
  const disabled =
    checking ||
    operation.pending ||
    !operation.writable ||
    record?.status === 'cancelled' ||
    requiresReload ||
    !catalog.data ||
    catalog.isError
  async function submit(draft: Draft) {
    if (disabled) return
    setLocalError('')
    if (!draft.currency) {
      setError(
        'currency',
        { message: 'Choose a currency.' },
        { shouldFocus: true },
      )
      return
    }
    let amount_minor: string
    try {
      amount_minor = toMinor(draft.amount, draft.currency)
    } catch (e) {
      setError(
        'amount',
        { message: e instanceof Error ? e.message : 'Check amount.' },
        { shouldFocus: true },
      )
      return
    }
    const parsed = profileSchema.safeParse({
      description: draft.description,
      internal_note: draft.internal_note,
      amount_minor,
      currency: draft.currency,
      due_date: draft.due_date || null,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        setError(
          (issue.path[0] === 'amount_minor'
            ? 'amount'
            : issue.path[0]) as FieldPath<Draft>,
          { message: issue.message },
          { shouldFocus: true },
        )
      return
    }
    let returned = false
    const result = await operation.run(async () => {
      const r = record
        ? await api.update(
            operation.clientID,
            record.id,
            parsed.data,
            record.revision,
          )
        : await api.create(operation.clientID, parsed.data)
      returned = true
      return r
    })
    if (result)
      navigate(pagePath(operation.clientID, result.id), { replace: true })
    else {
      setRequiresReload(true)
      setLocalError(
        returned
          ? 'The collection was saved, but access changed. Refresh your session before continuing.'
          : 'Reload current finance data before retrying. If confirmation was lost, check the collection list for an existing creation before creating another.',
      )
    }
  }
  return (
    <form
      noValidate
      onSubmit={handleSubmit(submit)}
      className="grid max-w-3xl gap-4 rounded-md border border-line bg-surface p-4 sm:p-5"
    >
      {record?.status === 'cancelled' ? (
        <p role="status">Cancelled collections are read only.</p>
      ) : null}
      {catalog.isPending ? (
        <p role="status">Loading supported currencies…</p>
      ) : catalog.isError ? (
        <BillingError
          error={catalog.error}
          retry={() => void catalog.refetch()}
        />
      ) : null}
      <fieldset disabled={disabled} className="grid gap-4">
        <label className="grid gap-1.5 text-sm font-semibold">
          Collection description
          <textarea
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('description')}
          />
          {errors.description ? (
            <span role="alert" className="text-xs text-danger-ink">
              {errors.description.message}
            </span>
          ) : null}
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          Currency
          <select
            className="ui-input"
            {...register('currency')}
            disabled={!!record}
          >
            <option value="">Choose currency</option>
            {catalog.data?.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.exponent} decimal places
              </option>
            ))}
          </select>
          {errors.currency ? (
            <span role="alert" className="text-xs text-danger-ink">
              {errors.currency.message}
            </span>
          ) : null}
        </label>
        <TextField
          label="Collection amount"
          description="Plain decimal major units. No rounding. Amount is fixed for copied pricing and after the first payment; origin checks keep it read only until confirmed."
          inputMode="decimal"
          maxLength={24}
          {...register('amount')}
          readOnly={!!record && (record.paid_minor !== '0' || copied)}
          error={errors.amount?.message ?? ''}
        />
        <TextField
          label="Due date (UTC calendar)"
          type="date"
          {...register('due_date')}
          error={errors.due_date?.message ?? ''}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          Internal note
          <textarea
            className="ui-input min-h-32"
            maxLength={8000}
            {...register('internal_note')}
          />
          {errors.internal_note ? (
            <span role="alert" className="text-xs text-danger-ink">
              {errors.internal_note.message}
            </span>
          ) : null}
        </label>
      </fieldset>
      {operation.error ? (
        <p role="alert" className="text-danger-ink">
          {operation.error}
        </p>
      ) : null}
      {localError ? <p role="alert">{localError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={operation.pending}
          disabled={disabled}
        >
          {record ? 'Save collection' : 'Create collection'}
        </Button>
        {requiresReload ? (
          <Button
            onClick={() =>
              navigate(pagePath(operation.clientID, record?.id), {
                replace: true,
              })
            }
          >
            Review current finance data
          </Button>
        ) : null}
        <Link
          className={buttonStyles()}
          to={pagePath(operation.clientID, record?.id)}
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
