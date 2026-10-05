import { SelectField } from '../../components/ui'
import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm, useWatch } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import {
  emptyMetadata,
  metadataSchema,
  priorities,
  statusLabels,
} from './models'
import type { Metadata, Task } from './models'
import type { useTasks } from './hooks'
import { AssigneePicker } from './AssigneePicker'
import { deviceTimezone, localInput, localTimestamp } from './time'
import * as api from './service'

type Draft = Omit<Metadata, 'tags' | 'assignee_id' | 'start_at' | 'due_at'> & {
  tags_text: string
  assignee: string
  start_local: string
  due_local: string
  status: 'backlog' | 'todo'
}
function draftOf(p: Metadata): Draft {
  return {
    title: p.title,
    description: p.description,
    priority: p.priority,
    tags_text: p.tags.join('\n'),
    assignee: p.assignee_id ?? '',
    start_local: localInput(p.start_at),
    due_local: localInput(p.due_at),
    status: 'todo',
  }
}
export function TaskForm({
  clientID,
  task,
  operation,
  onUnavailable,
}: {
  clientID: string
  task?: Task
  operation: ReturnType<typeof useTasks>
  onUnavailable: (message: string) => void
}) {
  useLocale()
  const navigate = useNavigate(),
    [revision, setRevision] = useState(task?.revision ?? 1),
    [baseline, setBaseline] = useState<Metadata>(task ?? emptyMetadata)
  const [reloading, setReloading] = useState(false),
    [reloadError, setReloadError] = useState('')
  const busy = operation.pending || reloading
  const {
    register,
    handleSubmit,
    reset,
    clearErrors,
    setError,
    control,
    setValue,
    formState: { errors },
  } = useForm<Draft>({ defaultValues: draftOf(baseline) })
  const assignee = useWatch({
    control,
    name: 'assignee',
    defaultValue: baseline.assignee_id ?? '',
  })
  async function submit(draft: Draft) {
    if (busy || !operation.writable) return
    clearErrors()
    let start: string | null, due: string | null
    try {
      start = localTimestamp(draft.start_local, baseline.start_at)
    } catch {
      setError(
        'start_local',
        { message: copy('Choose a valid local start time.', 'tasks') },
        { shouldFocus: true },
      )
      return
    }
    try {
      due = localTimestamp(draft.due_local, baseline.due_at)
    } catch {
      setError(
        'due_local',
        { message: copy('Choose a valid local due time.', 'tasks') },
        { shouldFocus: true },
      )
      return
    }
    const parsed = metadataSchema.safeParse({
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      assignee_id: draft.assignee || null,
      start_at: start,
      due_at: due,
      tags: draft.tags_text
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
    })
    if (!parsed.success) {
      const fields: Record<string, FieldPath<Draft>> = {
        tags: 'tags_text',
        assignee_id: 'assignee',
        start_at: 'start_local',
        due_at: 'due_local',
      }
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0])
        setError(
          fields[field] ?? (field as FieldPath<Draft>),
          { message: issue.message },
          { shouldFocus: true },
        )
      }
      return
    }
    const result = await operation.run(() =>
      task
        ? api.update(clientID, task.id, parsed.data, revision)
        : api.create(clientID, parsed.data, draft.status),
    )
    if (result)
      navigate(`/app/clients/${clientID}/tasks/${result.id}`, {
        replace: true,
        state: { taskSaved: task ? 'updated' : 'created' },
      })
  }
  async function reload() {
    if (busy || !task) return
    setReloading(true)
    setReloadError('')
    try {
      const current = await operation.read(() => api.detail(clientID, task.id))
      if (
        current.archived_at ||
        ['done', 'cancelled'].includes(current.status)
      ) {
        onUnavailable(
          current.archived_at
            ? copy('This task is archived. Its history is retained.', 'tasks')
            : copy('Reopen this task before editing its metadata.', 'tasks'),
        )
        return
      }
      operation.cache.setQueryData(
        [...operation.key, 'detail', task.id],
        current,
      )
      setRevision(current.revision)
      setBaseline(current)
      reset(draftOf(current))
      operation.clearError()
      if (operation.permissions.clientView) await operation.parent.refetch()
    } catch {
      setReloadError('Unable to reload this task. Try again.')
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
      <fieldset
        disabled={busy || !operation.writable}
        className="grid gap-4 form-section"
      >
        <legend className="px-1 font-semibold">
          {copy('Task details', 'tasks')}
        </legend>
        <TextField
          label={copy('Task title', 'tasks')}
          required
          maxLength={400}
          {...register('title')}
          error={copy(errors.title?.message, 'tasks') ?? ''}
        />
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="task-description">
            {copy('Description', 'tasks')}
          </label>
          <p className="text-xs text-muted" id="task-description-help">
            {copy(
              'Plain text, up to 8,000 characters. Line breaks are supported.',
              'tasks',
            )}
          </p>
          <textarea
            id="task-description"
            className="ui-input min-h-32"
            maxLength={16000}
            {...register('description')}
            aria-invalid={!!errors.description}
            aria-describedby="task-description-help task-description-error"
          />
          {errors.description ? (
            <p
              id="task-description-error"
              role="alert"
              className="text-xs text-danger-ink"
            >
              {copy(errors.description.message, 'tasks')}
            </p>
          ) : null}
        </div>
        <div className="field-grid grid gap-3 sm:grid-cols-2">
          <SelectField
            label={copy('Priority', 'tasks')}
            {...register('priority')}
          >
            {priorities.map((p) => (
              <option key={p} value={p}>
                {statusLabel(p)}
              </option>
            ))}
          </SelectField>
          {!task ? (
            <SelectField
              label={copy('Initial status', 'tasks')}
              {...register('status')}
            >
              {(['todo', 'backlog'] as const).map((s) => (
                <option key={s} value={s}>
                  {copy(statusLabels[s], 'tasks')}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <AssigneePicker
          clientID={clientID}
          operation={operation}
          value={assignee}
          onChange={(value) =>
            setValue('assignee', value, { shouldDirty: true })
          }
          disabled={busy}
          error={copy(errors.assignee?.message, 'tasks') ?? ''}
        />
        <p className="text-xs text-muted">
          {copy(
            'Enter dates in {{value1}}. During a repeated daylight-saving hour, a changed time uses its first occurrence.',
            'tasks',
            { value1: deviceTimezone() },
          )}
        </p>
        <div className="field-grid grid gap-3 sm:grid-cols-2">
          <TextField
            label={copy('Start time', 'tasks')}
            type="datetime-local"
            step={1}
            {...register('start_local')}
            error={copy(errors.start_local?.message, 'tasks') ?? ''}
          />
          <TextField
            label={copy('Due time', 'tasks')}
            type="datetime-local"
            step={1}
            {...register('due_local')}
            error={copy(errors.due_local?.message, 'tasks') ?? ''}
          />
        </div>
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="task-tags">
            {copy('Tags', 'tasks')}
          </label>
          <p className="text-xs text-muted" id="task-tags-help">
            {copy(
              'One tag per line, up to 20 distinct labels of 40 characters. Saved in lowercase.',
              'tasks',
            )}
          </p>
          <textarea
            id="task-tags"
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('tags_text')}
            aria-invalid={!!errors.tags_text}
            aria-describedby="task-tags-help task-tags-error"
          />
          {errors.tags_text ? (
            <p
              role="alert"
              id="task-tags-error"
              className="text-xs text-danger-ink"
            >
              {copy(errors.tags_text.message, 'tasks')}
            </p>
          ) : null}
        </div>
      </fieldset>
      {copy(operation.error, 'tasks') ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{copy(operation.error, 'tasks')}</p>
          {task && operation.errorCode === 'conflict' ? (
            <>
              <p className="mt-2 text-xs text-muted">
                {copy(
                  'Your draft is preserved. Reloading discards the draft and uses the current task revision.',
                  'tasks',
                )}
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                {copy('Reload current data', 'tasks')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reloadError ? (
        <p role="alert" className="text-danger-ink">
          {copy(reloadError, 'tasks')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel={copy('Saving task', 'tasks')}
          disabled={!operation.writable || operation.errorCode === 'conflict'}
        >
          {task ? copy('Save task', 'tasks') : copy('Create task', 'tasks')}
        </Button>
        <Link
          className={buttonStyles()}
          to={
            task
              ? `/app/clients/${clientID}/tasks/${task.id}`
              : `/app/clients/${clientID}/tasks`
          }
        >
          {copy('Cancel', 'tasks')}
        </Link>
      </div>
    </form>
  )
}
