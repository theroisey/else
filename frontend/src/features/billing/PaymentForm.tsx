import { SelectField } from '../../components/ui'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField } from '../../components/ui'
import { paymentSchema, methods, methodLabels } from './models'
import type { Collection, PaymentInput } from './models'
import type { Operation } from './Shared'
import { toMinor, money } from './money'
import { usePaymentRecovery } from './payment-recovery-context'
interface Draft {
  amount: string
  paid_on: string
  method: PaymentInput['method']
  reference: string
  note: string
}
export function PaymentForm({
  record,
  operation,
  checking,
}: {
  record: Collection
  operation: Operation
  checking: boolean
}) {
  useLocale()
  const recovery = usePaymentRecovery(),
    [message, setMessage] = useState('')
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Draft>({
    defaultValues: {
      amount: '',
      paid_on: new Date().toISOString().slice(0, 10),
      method: 'bank_transfer',
      reference: '',
      note: '',
    },
  })
  const disabled = checking || !operation.writable || recovery.busy
  function submit(draft: Draft) {
    if (disabled) return
    setMessage('')
    let amount_minor: string
    try {
      amount_minor = toMinor(draft.amount, record.currency)
    } catch (e) {
      setError(
        'amount',
        {
          message:
            e instanceof Error
              ? e.message
              : copy('Check the amount.', 'billing'),
        },
        { shouldFocus: true },
      )
      return
    }
    if (BigInt(amount_minor) > BigInt(record.outstanding_minor)) {
      setError(
        'amount',
        {
          message: copy(
            'Amount exceeds the current outstanding balance. Reload if the balance changed.',
            'billing',
          ),
        },
        { shouldFocus: true },
      )
      return
    }
    // Keep display-only major-unit input out of the API command.
    const result = paymentSchema.safeParse({
      command_id: crypto.randomUUID(),
      amount_minor,
      currency: record.currency,
      paid_on: draft.paid_on,
      method: draft.method,
      reference: draft.reference,
      note: draft.note,
    })
    if (!result.success) {
      for (const issue of result.error.issues)
        setError(
          issue.path[0] as FieldPath<Draft>,
          { message: issue.message },
          { shouldFocus: true },
        )
      return
    }
    if (result.data.paid_on > new Date().toISOString().slice(0, 10)) {
      setError(
        'paid_on',
        {
          message: copy(
            'Payment date cannot be later than today in UTC.',
            'billing',
          ),
        },
        { shouldFocus: true },
      )
      return
    }
    setMessage('Awaiting payment confirmation.')
    recovery.submit({
      client: operation.clientID,
      id: record.id,
      revision: record.revision,
      payment: result.data,
    })
  }
  return (
    <form
      noValidate
      onSubmit={handleSubmit(submit)}
      className="mt-6 grid max-w-3xl gap-4 form-section"
    >
      <h2 className="font-semibold">{copy('Record payment', 'billing')}</h2>
      <p className="text-sm text-muted">
        {copy(
          'Outstanding: {{value1}}. Records are permanent; verify the amount and payment date before submitting.',
          'billing',
          { value1: money(record.outstanding_minor, record.currency) },
        )}
      </p>
      <fieldset
        disabled={disabled}
        className="field-grid grid gap-4 sm:grid-cols-2"
      >
        <TextField
          label={copy('Payment amount ({{value1}})', 'billing', {
            value1: record.currency,
          })}
          inputMode="decimal"
          maxLength={24}
          {...register('amount')}
          error={copy(errors.amount?.message, 'billing') ?? ''}
        />
        <TextField
          label={copy('Payment date (UTC calendar)', 'billing')}
          type="date"
          {...register('paid_on')}
          error={copy(errors.paid_on?.message, 'billing') ?? ''}
        />
        <SelectField
          label={copy('Payment method', 'billing')}
          {...register('method')}
        >
          {methods.map((m) => (
            <option key={m} value={m}>
              {copy(methodLabels[m], 'billing')}
            </option>
          ))}
        </SelectField>
        <TextField
          label={copy('Payment reference', 'billing')}
          description={copy(
            'Optional. Use a short reference, never credentials or full card/account details.',
            'billing',
          )}
          maxLength={200}
          autoComplete="off"
          {...register('reference')}
          error={copy(errors.reference?.message, 'billing') ?? ''}
        />
        <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
          {copy('Payment note', 'billing')}{' '}
          <textarea
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('note')}
          />
          {errors.note ? (
            <span role="alert" className="text-xs text-danger-ink">
              {copy(errors.note.message, 'billing')}
            </span>
          ) : null}
        </label>
      </fieldset>
      {message && recovery.busy ? (
        <p role="status">{copy(message, 'billing')}</p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        className="justify-self-start"
        disabled={disabled}
      >
        {copy('Record payment', 'billing')}
      </Button>
    </form>
  )
}
