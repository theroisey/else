import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { Button, TextField } from '../../components/ui'
import { money } from '../billing/money'
import { utcToday } from './exact'
import { copySchema, effective } from './models'
import type { Version } from './models'
import type { Operation } from './Shared'
import { useCopyRecovery } from './copy-recovery-context'
export function CopyForm({
  operation: op,
  version: v,
  revision,
  checking,
}: {
  operation: Operation
  version: Version
  revision: string
  checking: boolean
}) {
  const recovery = useCopyRecovery(),
    [error, setError] = useState(''),
    { register, handleSubmit, control } = useForm({
      defaultValues: {
        billing_date: utcToday(),
        due_date: '',
        internal_note: '',
        confirm: false,
      },
    }),
    date = useWatch({ control, name: 'billing_date' }),
    disabled =
      checking || recovery.busy || !op.writable || v.total_minor === '0'
  function submit(d: {
    billing_date: string
    due_date: string
    internal_note: string
    confirm: boolean
  }) {
    if (disabled) return
    const parsed = copySchema.safeParse({
      command_id: crypto.randomUUID(),
      billing_date: d.billing_date,
      due_date: d.due_date || null,
      internal_note: d.internal_note,
    })
    if (!parsed.success || !effective(v, d.billing_date) || !d.confirm) {
      setError(
        'Confirm the amount and choose a real billing date within this version’s effective window, no later than UTC today. Check the due date and note.',
      )
      return
    }
    setError('')
    recovery.submit({
      client: op.clientID,
      sheet: v.sheet_id,
      version: v.id,
      revision,
      input: parsed.data,
      currency: v.currency,
      total: v.total_minor,
    })
  }
  return (
    <form
      noValidate
      onSubmit={handleSubmit(submit)}
      className="mt-6 grid gap-4 form-section"
    >
      <h2 className="text-lg font-semibold">
        Create collection from this version
      </h2>
      <p className="text-sm">
        Version {v.revision} · Fixed amount {money(v.total_minor, v.currency)}.
        Copied lines and amount remain unchanged when pricing changes. Internal
        costs and pricing notes are excluded.
      </p>
      {v.total_minor === '0' ? (
        <p role="status">A zero-total agreement cannot create a collection.</p>
      ) : null}
      <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Billing date (UTC calendar)"
          type="date"
          max={utcToday()}
          {...register('billing_date')}
        />
        <TextField
          label="Collection due date (UTC calendar)"
          type="date"
          {...register('due_date')}
        />
        <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
          Collection internal note
          <textarea
            className="ui-input min-h-24"
            maxLength={8000}
            {...register('internal_note')}
          />
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="mt-1" {...register('confirm')} />I
          confirm this fixed collection amount.
        </label>
      </fieldset>
      {!effective(v, date) ? (
        <p role="status" className="text-sm">
          This version is not effective on the selected billing date.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <p className="text-xs text-muted">
        Keep this page open until confirmed. A lost response must be reconciled
        with the original command before any replacement collection.
      </p>
      <Button
        variant="primary"
        type="submit"
        disabled={disabled || !effective(v, date)}
      >
        Create collection from version
      </Button>
    </form>
  )
}
