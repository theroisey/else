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
        { message: e instanceof Error ? e.message : 'Check the amount.' },
        { shouldFocus: true },
      )
      return
    }
    if (BigInt(amount_minor) > BigInt(record.outstanding_minor)) {
      setError(
        'amount',
        {
          message:
            'Amount exceeds the current outstanding balance. Reload if the balance changed.',
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
        { message: 'Payment date cannot be later than today in UTC.' },
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
      <h2 className="font-semibold">Record payment</h2>
      <p className="text-sm text-muted">
        Outstanding: {money(record.outstanding_minor, record.currency)}. Records
        are permanent; verify the amount and payment date before submitting.
      </p>
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={`Payment amount (${record.currency})`}
          inputMode="decimal"
          maxLength={24}
          {...register('amount')}
          error={errors.amount?.message ?? ''}
        />
        <TextField
          label="Payment date (UTC calendar)"
          type="date"
          {...register('paid_on')}
          error={errors.paid_on?.message ?? ''}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          Payment method
          <select className="ui-input" {...register('method')}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {methodLabels[m]}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label="Payment reference"
          description="Optional. Use a short reference, never credentials or full card/account details."
          maxLength={200}
          autoComplete="off"
          {...register('reference')}
          error={errors.reference?.message ?? ''}
        />
        <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
          Payment note
          <textarea
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('note')}
          />
          {errors.note ? (
            <span role="alert" className="text-xs text-danger-ink">
              {errors.note.message}
            </span>
          ) : null}
        </label>
      </fieldset>
      {message && recovery.busy ? <p role="status">{message}</p> : null}
      <Button
        type="submit"
        variant="primary"
        className="justify-self-start"
        disabled={disabled}
      >
        Record payment
      </Button>
    </form>
  )
}
