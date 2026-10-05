import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm, useWatch } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { emptyMetadata, metadataSchema, priorities, statusLabels } from './models'
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
  const assignee = useWatch({ control, name: 'assignee', defaultValue: baseline.assignee_id ?? '' })
  async function submit(draft: Draft) {
    if (busy || !operation.writable) return
    clearErrors()
    let start: string | null, due: string | null
    try {
      start = localTimestamp(draft.start_local, baseline.start_at)
    } catch {
      setError(
        'start_local',
        { message: 'Choose a valid local start time.' },
        { shouldFocus: true },
      )
      return
    }
    try {
      due = localTimestamp(draft.due_local, baseline.due_at)
    } catch {
      setError('due_local', { message: 'Choose a valid local due time.' }, { shouldFocus: true })
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
      if (current.archived_at || ['done', 'cancelled'].includes(current.status)) {
        onUnavailable(
          current.archived_at
            ? 'This task is archived. Its history is retained.'
            : 'Reopen this task before editing its metadata.',
        )
        return
      }
      operation.cache.setQueryData([...operation.key, 'detail', task.id], current)
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
        <legend className="px-1 font-semibold">Task details</legend>
        <TextField
          label="Task title"
          required
          maxLength={400}
          {...register('title')}
          error={errors.title?.message ?? ''}
        />
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="task-description">
            Description
          </label>
          <p className="text-xs text-muted" id="task-description-help">
            Plain text, up to 8,000 characters. Line breaks are supported.
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
            <p id="task-description-error" role="alert" className="text-xs text-danger-ink">
              {errors.description.message}
            </p>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 font-semibold">
            Priority
            <select className="ui-input font-normal" {...register('priority')}>
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
          {!task ? (
            <label className="grid gap-1.5 font-semibold">
              Initial status
              <select className="ui-input font-normal" {...register('status')}>
                {(['todo', 'backlog'] as const).map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <AssigneePicker
          clientID={clientID}
          operation={operation}
          value={assignee}
          onChange={(value) => setValue('assignee', value, { shouldDirty: true })}
          disabled={busy}
          error={errors.assignee?.message ?? ''}
        />
        <p className="text-xs text-muted">
          Enter dates in {deviceTimezone()}. During a repeated daylight-saving hour, a changed time
          uses its first occurrence.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Start time"
            type="datetime-local"
            step={1}
            {...register('start_local')}
            error={errors.start_local?.message ?? ''}
          />
          <TextField
            label="Due time"
            type="datetime-local"
            step={1}
            {...register('due_local')}
            error={errors.due_local?.message ?? ''}
          />
        </div>
        <div className="grid gap-1.5">
          <label className="font-semibold" htmlFor="task-tags">
            Tags
          </label>
          <p className="text-xs text-muted" id="task-tags-help">
            One tag per line, up to 20 distinct labels of 40 characters. Saved in lowercase.
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
            <p role="alert" id="task-tags-error" className="text-xs text-danger-ink">
              {errors.tags_text.message}
            </p>
          ) : null}
        </div>
      </fieldset>
      {operation.error ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{operation.error}</p>
          {task && operation.errorCode === 'conflict' ? (
            <>
              <p className="mt-2 text-xs text-muted">
                Your draft is preserved. Reloading discards the draft and uses the current task
                revision.
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
          loadingLabel="Saving task"
          disabled={!operation.writable || operation.errorCode === 'conflict'}
        >
          {task ? 'Save task' : 'Create task'}
        </Button>
        <Link
          className={buttonStyles()}
          to={task ? `/app/clients/${clientID}/tasks/${task.id}` : `/app/clients/${clientID}/tasks`}
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
