import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm, useWatch } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { deviceTimezone } from '../../lib/time'
import { profileSchema, pagePath } from './models'
import type { RecordData, Resource } from './models'
import { occurrences, offsetLabel, wallClock, utcFromWall } from './time'
import type { Operation } from './Shared'
import { OwnerPicker } from './OwnerPicker'
import { ResourcePicker } from './ResourcePicker'
import * as api from './service'
interface Draft {
  title: string
  description: string
  owner_id: string
  date: string
  time: string
  timezone: string
  resource: Resource | null
}
const draftOf = (record: RecordData | undefined, actor: string): Draft => ({
  title: record?.title ?? '',
  description: record?.description ?? '',
  owner_id: record?.owner_id ?? actor,
  date: record?.scheduled_local.slice(0, 10) ?? '',
  time: record?.scheduled_local.slice(11) ?? '09:00:00',
  timezone: record?.timezone ?? deviceTimezone(),
  resource: record?.resource ?? null,
})
export function ReminderForm({
  record,
  operation,
  checking = false,
}: {
  record?: RecordData
  operation: Operation
  checking?: boolean
}) {
  const navigate = useNavigate(),
    actor = operation.auth.session!.user.id
  const [baseline, setBaseline] = useState(record),
    [revision, setRevision] = useState(record?.revision ?? 1),
    [selection, setSelection] = useState({ signature: '', offset: '' }),
    [reloading, setReloading] = useState(false),
    [reloadError, setReloadError] = useState(''),
    [unavailable, setUnavailable] = useState(false)
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError,
    clearErrors,
    reset,
    formState: { errors },
  } = useForm<Draft>({ defaultValues: draftOf(record, actor) })
  const [date, time, timezone, owner, resource] = useWatch({
    control,
    name: ['date', 'time', 'timezone', 'owner_id', 'resource'],
  })
  const local = date + 'T' + time,
    signature = local + '|' + timezone
  let choices: ReturnType<typeof occurrences> = [],
    scheduleError = '',
    unchanged = false
  try {
    unchanged =
      !!baseline &&
      wallClock(local).local === baseline.scheduled_local &&
      timezone === baseline.timezone
    choices = occurrences(local, timezone)
    if (!choices.length && !unchanged)
      scheduleError =
        'This local time does not exist in the selected timezone, or falls outside the supported year bounds.'
  } catch (error) {
    if (date && time && !unchanged)
      scheduleError = error instanceof Error ? error.message : 'Check the schedule.'
  }
  const offset =
    selection.signature === signature && selection.offset !== ''
      ? Number(selection.offset)
      : unchanged
        ? baseline!.utc_offset_seconds
        : choices.length === 1
          ? choices[0]!.offset
          : undefined
  const preview = offset === undefined || scheduleError ? '' : utcFromWall(local, offset)
  const busy = operation.pending || reloading,
    blocked = unavailable || (record && record.status !== 'pending'),
    disabled = busy || checking || !operation.writable || !!blocked
  async function submit(draft: Draft) {
    if (disabled) return
    clearErrors()
    if (
      draft.resource &&
      JSON.stringify(draft.resource) !== JSON.stringify(baseline?.resource ?? null) &&
      !(draft.resource.kind === 'task'
        ? operation.permissions.taskView
        : operation.permissions.planningView)
    ) {
      setError('resource', {
        message:
          'Clear the new reference or restore the recorded reference before saving without independent resource access.',
      })
      return
    }
    if (scheduleError || offset === undefined || !preview) {
      setError(
        'time',
        { message: scheduleError || 'Choose the intended occurrence of this repeated local time.' },
        { shouldFocus: true },
      )
      return
    }
    const parsed = profileSchema.safeParse({
      title: draft.title,
      description: draft.description,
      owner_id: draft.owner_id,
      timezone: draft.timezone,
      scheduled_local: wallClock(draft.date + 'T' + draft.time).local,
      utc_offset_seconds: offset,
      resource: draft.resource,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        setError(
          (issue.path[0] === 'scheduled_local' ? 'time' : issue.path[0]) as FieldPath<Draft>,
          { message: issue.message },
          { shouldFocus: true },
        )
      return
    }
    const result = await operation.run(() =>
      record
        ? api.update(operation.clientID, record.id, parsed.data, revision)
        : api.create(operation.clientID, parsed.data),
    )
    if (result)
      navigate(pagePath(operation.clientID, result.id), {
        replace: true,
        state: { reminderSaved: record ? 'updated' : 'created' },
      })
  }
  async function reload() {
    if (busy || !record) return
    setReloading(true)
    setReloadError('')
    try {
      const current = await operation.read(() => api.detail(operation.clientID, record.id))
      operation.cache.setQueryData([...operation.key, 'detail', record.id], current)
      if (current.status !== 'pending') {
        setUnavailable(true)
        return
      }
      setBaseline(current)
      setRevision(current.revision)
      reset(draftOf(current, actor))
      setSelection({ signature: '', offset: '' })
      operation.clearError()
      if (operation.permissions.clientView) await operation.client.refetch()
    } catch {
      setReloadError('Unable to reload this reminder. Try again.')
    } finally {
      setReloading(false)
    }
  }
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
        <p role="status">This reminder is terminal and read only.</p>
      ) : !operation.writable ? (
        <p role="status">Changes are unavailable while the client is archived or being checked.</p>
      ) : null}
      <fieldset
        disabled={disabled}
        className="grid min-w-0 gap-4 rounded-md border border-line bg-surface p-5"
      >
        <legend className="px-1 font-semibold">Reminder details</legend>
        <TextField
          label="Reminder title"
          required
          maxLength={400}
          {...register('title')}
          error={errors.title?.message ?? ''}
        />
        <label className="grid gap-1.5 font-semibold">
          Description
          <textarea
            className="ui-input min-h-32 font-normal"
            maxLength={16000}
            {...register('description')}
            aria-invalid={!!errors.description}
            aria-describedby="reminder-description-help"
          />
        </label>
        <p id="reminder-description-help" className="text-xs text-muted">
          Plain text, up to 8,000 characters. Line breaks are supported.
        </p>
        {errors.description ? (
          <p role="alert" className="text-xs text-danger-ink">
            {errors.description.message}
          </p>
        ) : null}
        <OwnerPicker
          operation={operation}
          value={owner}
          onChange={(v) => setValue('owner_id', v)}
          disabled={disabled}
          error={errors.owner_id?.message ?? ''}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Scheduled date"
            type="date"
            required
            {...register('date', { onChange: () => setSelection({ signature: '', offset: '' }) })}
            error={errors.date?.message ?? ''}
          />
          <TextField
            label="Local time"
            placeholder="09:00:00"
            required
            {...register('time', { onChange: () => setSelection({ signature: '', offset: '' }) })}
            error={errors.time?.message ?? ''}
          />
        </div>
        <p className="text-xs text-muted">
          Time: HH:mm:ss, with up to six fractional digits. Past times are due immediately.
        </p>
        <TextField
          label="Timezone"
          required
          {...register('timezone', { onChange: () => setSelection({ signature: '', offset: '' }) })}
          error={errors.timezone?.message ?? ''}
        />
        <p className="text-xs text-muted">
          Use a named IANA timezone, such as Europe/Istanbul, America/New_York or UTC. Changing the
          timezone keeps the typed local time; review the new UTC instant.
        </p>
        {scheduleError ? (
          <p role="status" className="text-danger-ink">
            {scheduleError}
          </p>
        ) : choices.length > 1 ? (
          <fieldset className="grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 font-semibold">Repeated local time</legend>
            <p className="text-xs text-muted">
              Choose the intended occurrence. Both represent the same wall clock.
            </p>
            {choices.map((c, i) => (
              <label key={c.utc} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="reminder-occurrence"
                  value={c.offset}
                  checked={offset === c.offset}
                  onChange={() => {
                    clearErrors('time')
                    setSelection({ signature, offset: String(c.offset) })
                  }}
                />
                <span>
                  {i === 0 ? 'Earlier' : 'Later'} occurrence · {offsetLabel(c.offset)} · {c.utc}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {preview ? (
          <p className="break-all text-sm" role="status">
            Scheduled UTC instant: <time dateTime={preview}>{preview}</time> ·{' '}
            {offsetLabel(offset!)}
          </p>
        ) : null}
        {unchanged && offset === baseline?.utc_offset_seconds ? (
          <p className="text-xs text-muted">
            The recorded wall clock and selected offset are retained. The server checks current
            rules when saving metadata.
          </p>
        ) : null}
        {errors.resource ? (
          <p role="alert" className="text-xs text-danger-ink">
            {errors.resource.message}
          </p>
        ) : null}
        {baseline?.resource && JSON.stringify(resource) !== JSON.stringify(baseline.resource) ? (
          <Button
            size="compact"
            disabled={disabled}
            onClick={() => {
              clearErrors('resource')
              setValue('resource', baseline.resource)
            }}
          >
            Restore recorded reference
          </Button>
        ) : null}
        <ResourcePicker
          operation={operation}
          value={resource}
          onChange={(v) => {
            clearErrors('resource')
            setValue('resource', v)
          }}
          disabled={disabled}
        />
      </fieldset>
      {operation.error ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{operation.error}</p>
          {record && operation.errorCode === 'conflict' ? (
            <>
              <p className="mt-2 text-xs text-muted">
                Your draft is preserved. Reloading discards it and uses the current record.
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
          loadingLabel="Saving reminder"
          disabled={disabled || operation.errorCode === 'conflict'}
        >
          {record ? 'Save reminder' : 'Create reminder'}
        </Button>
        <Link className={buttonStyles()} to={pagePath(operation.clientID, record?.id)}>
          Cancel
        </Link>
      </div>
    </form>
  )
}
