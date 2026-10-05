import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { emptyMetadata, metadataSchema, pagePath, recordKey, terminal } from './models'
import type { Metadata, RecordData } from './models'
import type { Operation } from './Shared'
import { deviceTimezone, instant, localInput, localTimestamp } from '../../lib/time'
import * as api from './service'
type Draft = { title: string; description: string; start_local: string; due_local: string }
const draftOf = (m: Metadata): Draft => ({
  title: m.title,
  description: m.description,
  start_local: localInput(m.start_at),
  due_local: localInput(m.due_at),
})
export function PlanningForm({
  record,
  operation,
  checking = false,
}: {
  record?: RecordData
  operation: Operation
  checking?: boolean
}) {
  const { scope } = operation
  const navigate = useNavigate()
  const [baseline, setBaseline] = useState<Metadata>(record ?? emptyMetadata),
    [revision, setRevision] = useState(record?.revision ?? 1),
    [reloading, setReloading] = useState(false),
    [reloadError, setReloadError] = useState(''),
    [unavailable, setUnavailable] = useState('')
  const {
    register,
    handleSubmit,
    reset,
    clearErrors,
    setError,
    formState: { errors },
  } = useForm<Draft>({ defaultValues: draftOf(baseline) })
  const blocked = unavailable || (!!record && (!!record.archived_at || terminal(record.status)))
  const busy = operation.pending || reloading,
    disabled = busy || checking || !operation.writable || !!blocked
  async function submit(draft: Draft) {
    if (disabled) return
    clearErrors()
    let start: string | null = null,
      due: string | null = null
    const dateFields: ('start_local' | 'due_local')[] = scope.planID
      ? ['due_local']
      : ['start_local', 'due_local']
    for (const field of dateFields) {
      try {
        const value = localTimestamp(
          draft[field],
          field === 'start_local' ? baseline.start_at : baseline.due_at,
        )
        if (field === 'start_local') start = value
        else due = value
      } catch {
        setError(field, { message: 'Choose a valid local date and time.' }, { shouldFocus: true })
        return
      }
    }
    const parsed = metadataSchema.safeParse({
      title: draft.title,
      description: draft.description,
      start_at: start,
      due_at: due,
    })
    if (!parsed.success) {
      const fields: Record<string, FieldPath<Draft>> = {
        start_at: 'start_local',
        due_at: 'due_local',
      }
      for (const issue of parsed.error.issues)
        setError(
          fields[String(issue.path[0])] ?? (String(issue.path[0]) as FieldPath<Draft>),
          { message: issue.message },
          { shouldFocus: true },
        )
      return
    }
    const parent = operation.parent.data
    if (
      due &&
      scope.planID &&
      parent &&
      ((parent.start_at && instant(due) < instant(parent.start_at)) ||
        (parent.due_at && instant(due) > instant(parent.due_at)))
    ) {
      setError(
        'due_local',
        { message: 'Milestone due time must be inside the current plan date window.' },
        { shouldFocus: true },
      )
      return
    }
    const result = await operation.run(() =>
      record ? api.update(scope, record.id, parsed.data, revision) : api.create(scope, parsed.data),
    )
    if (result)
      navigate(pagePath(scope, result.id), {
        replace: true,
        state: { planningSaved: record ? 'updated' : 'created' },
      })
  }
  async function reload() {
    if (busy || !record) return
    setReloading(true)
    setReloadError('')
    try {
      const current = await operation.read(() => api.detail(scope, record.id))
      operation.cache.setQueryData([...operation.key, ...recordKey(scope, record.id)], current)
      if (current.archived_at || terminal(current.status)) {
        setUnavailable(
          'This record is archived or terminal. Reopen an unarchived record before editing.',
        )
        return
      }
      setBaseline(current)
      setRevision(current.revision)
      reset(draftOf(current))
      operation.clearError()
      if (scope.planID) await operation.parent.refetch()
      if (operation.permissions.clientView) await operation.client.refetch()
    } catch {
      setReloadError('Unable to reload this record. Try again.')
    } finally {
      setReloading(false)
    }
  }
  const name = scope.planID ? 'milestone' : 'plan'
  return (
    <form
      noValidate
      className="grid max-w-3xl gap-5"
      aria-busy={busy}
      onSubmit={(e) => {
        void handleSubmit(submit)(e)
      }}
    >
      {blocked ? (
        <p role="status">
          This record is archived or terminal. Reopen an unarchived record before editing.
        </p>
      ) : !operation.writable ? (
        <p role="status">
          Changes are unavailable while the client or parent plan is archived, terminal, or being
          checked.
        </p>
      ) : null}
      <fieldset
        disabled={disabled}
        className="grid min-w-0 gap-4 form-section"
      >
        <legend className="px-1 font-semibold">
          {scope.planID ? 'Milestone' : 'Plan'} details
        </legend>
        <TextField
          label={scope.planID ? 'Milestone title' : 'Plan title'}
          required
          maxLength={400}
          {...register('title')}
          error={errors.title?.message ?? ''}
        />
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="planning-description">
            Description
          </label>
          <p className="text-xs text-muted" id="planning-description-help">
            Plain text, up to 8,000 characters. Line breaks are supported.
          </p>
          <textarea
            id="planning-description"
            className="ui-input min-h-32"
            maxLength={16000}
            {...register('description')}
            aria-invalid={!!errors.description}
            aria-describedby="planning-description-help planning-description-error"
          />
          {errors.description ? (
            <p id="planning-description-error" role="alert" className="text-xs text-danger-ink">
              {errors.description.message}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          Enter dates in {deviceTimezone()}. During a repeated daylight-saving hour, a changed time
          uses its first occurrence.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {!scope.planID ? (
            <TextField
              label="Start time"
              type="datetime-local"
              step={1}
              {...register('start_local')}
              error={errors.start_local?.message ?? ''}
            />
          ) : null}
          <TextField
            label="Due time"
            type="datetime-local"
            step={1}
            {...register('due_local')}
            error={errors.due_local?.message ?? ''}
          />
        </div>
        <p className="text-xs text-muted">
          {scope.planID
            ? 'Due time must be inside the supplied plan dates.'
            : 'Changing plan dates must preserve all nonarchived milestone due dates.'}{' '}
          Dates do not change status automatically.
        </p>
      </fieldset>
      {operation.error ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{operation.error}</p>
          {record && operation.errorCode === 'conflict' ? (
            <>
              <p className="mt-2 text-xs text-muted">
                Your draft is preserved. Reloading discards the draft and uses the current record.
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                Reload current data
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reloadError ? (
        <p role="alert" className="text-danger-ink">
          {reloadError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel={`Saving ${name}`}
          disabled={disabled || operation.errorCode === 'conflict'}
        >
          {record ? 'Save ' + name : 'Create ' + name}
        </Button>
        <Link className={buttonStyles()} to={pagePath(scope, record?.id)}>
          Cancel
        </Link>
      </div>
    </form>
  )
}
