import { copy, useLocale } from '../../i18n/index'
import { Link, useNavigate, useParams } from 'react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import {
  Button,
  TextField,
  buttonStyles,
  PageSkeleton,
} from '../../components/ui'
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
  useLocale()
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
  useLocale()
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
  const snapshot = useBillingSnapshot(
    operation,
    create || query.isError ? undefined : query.data,
  )
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <BillingHeader
        title={
          create
            ? copy('Create collection', 'billing')
            : copy('Edit collection', 'billing')
        }
        operation={operation}
      />
      {!create && query.data && snapshot.isPending ? (
        <p role="status">
          {copy('Checking collection price origin…', 'billing')}
        </p>
      ) : null}
      {!create && snapshot.isError ? (
        <BillingError
          error={snapshot.error}
          retry={() => void snapshot.refetch()}
        />
      ) : null}
      {!create && query.isPending ? (
        <PageSkeleton label={copy('Loading collection…', 'billing')} />
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
          copied={
            snapshot.data !== null || snapshot.isError || snapshot.isFetching
          }
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
  useLocale()
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
        { message: copy('Choose a currency.', 'billing') },
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
        {
          message:
            e instanceof Error ? e.message : copy('Check amount.', 'billing'),
        },
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
          ? copy(
              'The collection was saved, but access changed. Refresh your session before continuing.',
              'billing',
            )
          : copy(
              'Reload current finance data before retrying. If confirmation was lost, check the collection list for an existing creation before creating another.',
              'billing',
            ),
      )
    }
  }
  return (
    <form
      noValidate
      onSubmit={handleSubmit(submit)}
      className="grid max-w-3xl gap-4 form-section"
    >
      {record?.status === 'cancelled' ? (
        <p role="status">
          {copy('Cancelled collections are read only.', 'billing')}
        </p>
      ) : null}
      {catalog.isPending ? (
        <PageSkeleton
          label={copy('Loading supported currencies…', 'billing')}
        />
      ) : catalog.isError ? (
        <BillingError
          error={catalog.error}
          retry={() => void catalog.refetch()}
        />
      ) : null}
      <fieldset disabled={disabled} className="field-grid grid gap-4">
        <label className="grid gap-1.5 text-sm font-semibold">
          {copy('Collection description', 'billing')}{' '}
          <textarea
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('description')}
          />
          {errors.description ? (
            <span role="alert" className="text-xs text-danger-ink">
              {copy(errors.description.message, 'billing')}
            </span>
          ) : null}
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          {copy('Currency', 'billing')}{' '}
          <select
            className="ui-input"
            {...register('currency')}
            disabled={!!record}
          >
            <option value="">{copy('Choose currency', 'billing')}</option>
            {catalog.data?.map((c) => (
              <option key={c.code} value={c.code}>
                {copy('{{value1}} · {{value2}} decimal places', 'billing', {
                  value1: c.code,
                  value2: c.exponent,
                })}
              </option>
            ))}
          </select>
          {errors.currency ? (
            <span role="alert" className="text-xs text-danger-ink">
              {copy(errors.currency.message, 'billing')}
            </span>
          ) : null}
        </label>
        <TextField
          label={copy('Collection amount', 'billing')}
          description={copy(
            'Plain decimal major units. No rounding. Amount is fixed for copied pricing and after the first payment; origin checks keep it read only until confirmed.',
            'billing',
          )}
          inputMode="decimal"
          maxLength={24}
          {...register('amount')}
          readOnly={!!record && (record.paid_minor !== '0' || copied)}
          error={copy(errors.amount?.message, 'billing') ?? ''}
        />
        <TextField
          label={copy('Due date (UTC calendar)', 'billing')}
          type="date"
          {...register('due_date')}
          error={copy(errors.due_date?.message, 'billing') ?? ''}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          {copy('Internal note', 'billing')}{' '}
          <textarea
            className="ui-input min-h-32"
            maxLength={8000}
            {...register('internal_note')}
          />
          {errors.internal_note ? (
            <span role="alert" className="text-xs text-danger-ink">
              {copy(errors.internal_note.message, 'billing')}
            </span>
          ) : null}
        </label>
      </fieldset>
      {copy(operation.error, 'billing') ? (
        <p role="alert" className="text-danger-ink">
          {copy(operation.error, 'billing')}
        </p>
      ) : null}
      {localError ? <p role="alert">{copy(localError, 'billing')}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={operation.pending}
          disabled={disabled}
        >
          {record
            ? copy('Save collection', 'billing')
            : copy('Create collection', 'billing')}
        </Button>
        {requiresReload ? (
          <Button
            onClick={() =>
              navigate(pagePath(operation.clientID, record?.id), {
                replace: true,
              })
            }
          >
            {copy('Review current finance data', 'billing')}
          </Button>
        ) : null}
        <Link
          className={buttonStyles()}
          to={pagePath(operation.clientID, record?.id)}
        >
          {copy('Cancel', 'billing')}
        </Link>
      </div>
    </form>
  )
}
