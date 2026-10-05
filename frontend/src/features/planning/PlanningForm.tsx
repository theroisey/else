import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import {
  emptyMetadata,
  metadataSchema,
  pagePath,
  recordKey,
  terminal,
} from './models'
import type { Metadata, RecordData } from './models'
import type { Operation } from './Shared'
import {
  deviceTimezone,
  instant,
  localInput,
  localTimestamp,
} from '../../lib/time'
import * as api from './service'
type Draft = {
  title: string
  description: string
  start_local: string
  due_local: string
}
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
  useLocale()
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
  const blocked =
    unavailable ||
    (!!record && (!!record.archived_at || terminal(record.status)))
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
        setError(
          field,
          { message: 'Choose a valid local date and time.' },
          { shouldFocus: true },
        )
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
          fields[String(issue.path[0])] ??
            (String(issue.path[0]) as FieldPath<Draft>),
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
        {
          message:
            'Milestone due time must be inside the current plan date window.',
        },
        { shouldFocus: true },
      )
      return
    }
    const result = await operation.run(() =>
      record
        ? api.update(scope, record.id, parsed.data, revision)
        : api.create(scope, parsed.data),
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
      operation.cache.setQueryData(
        [...operation.key, ...recordKey(scope, record.id)],
        current,
      )
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
  const name = copy(scope.planID ? 'milestone' : 'plan', 'planning')
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
          {copy(
            'This record is archived or terminal. Reopen an unarchived record before editing.',
            'planning',
          )}
        </p>
      ) : !operation.writable ? (
        <p role="status">
          {copy(
            'Changes are unavailable while the client or parent plan is archived, terminal, or being checked.',
            'planning',
          )}
        </p>
      ) : null}
      <fieldset disabled={disabled} className="grid min-w-0 gap-4 form-section">
        <legend className="px-1 font-semibold">
          {scope.planID
            ? copy('Milestone details', 'planning')
            : copy('Plan details', 'planning')}
        </legend>
        <TextField
          label={
            scope.planID
              ? copy('Milestone title', 'planning')
              : copy('Plan title', 'planning')
          }
          required
          maxLength={400}
          {...register('title')}
          error={copy(errors.title?.message, 'planning') ?? ''}
        />
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="planning-description">
            {copy('Description', 'planning')}
          </label>
          <p className="text-xs text-muted" id="planning-description-help">
            {copy(
              'Plain text, up to 8,000 characters. Line breaks are supported.',
              'planning',
            )}
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
            <p
              id="planning-description-error"
              role="alert"
              className="text-xs text-danger-ink"
            >
              {copy(errors.description.message, 'planning')}
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          {copy(
            'Enter dates in {{value1}}. During a repeated daylight-saving hour, a changed time uses its first occurrence.',
            'planning',
            { value1: deviceTimezone() },
          )}
        </p>
        <div className="field-grid grid gap-3 sm:grid-cols-2">
          {!scope.planID ? (
            <TextField
              label={copy('Start time', 'planning')}
              type="datetime-local"
              step={1}
              {...register('start_local')}
              error={copy(errors.start_local?.message, 'planning') ?? ''}
            />
          ) : null}
          <TextField
            label={copy('Due time', 'planning')}
            type="datetime-local"
            step={1}
            {...register('due_local')}
            error={copy(errors.due_local?.message, 'planning') ?? ''}
          />
        </div>
        <p className="text-xs text-muted">
          {copy(
            scope.planID
              ? 'Due time must be inside the supplied plan dates. Dates do not change status automatically.'
              : 'Changing plan dates must preserve all nonarchived milestone due dates. Dates do not change status automatically.',
            'planning',
          )}
        </p>
      </fieldset>
      {copy(operation.error, 'planning') ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{copy(operation.error, 'planning')}</p>
          {record && operation.errorCode === 'conflict' ? (
            <>
              <p className="mt-2 text-xs text-muted">
                {copy(
                  'Your draft is preserved. Reloading discards the draft and uses the current record.',
                  'planning',
                )}
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                {copy('Reload current data', 'planning')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reloadError ? (
        <p role="alert" className="text-danger-ink">
          {copy(reloadError, 'planning')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel={copy('Saving {{value1}}', 'planning', { value1: name })}
          disabled={disabled || operation.errorCode === 'conflict'}
        >
          {copy(record ? 'Save {{value1}}' : 'Create {{value1}}', 'planning', {
            value1: name,
          })}
        </Button>
        <Link className={buttonStyles()} to={pagePath(scope, record?.id)}>
          {copy('Cancel', 'planning')}
        </Link>
      </div>
    </form>
  )
}
