import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import type { FormEvent } from 'react'
import { Button, TextField } from '../../components/ui'
import { priorities, statuses, statusLabels } from './models'
import type { Filter } from './models'
export function TaskFilters({
  draft,
  setDraft,
  actor,
  onApply,
}: {
  draft: Filter
  setDraft: (f: Filter) => void
  actor: string
  onApply: (e: FormEvent) => void
}) {
  useLocale()
  return (
    <form
      className="mb-5 grid items-end gap-3 filter-bar sm:grid-cols-2 xl:grid-cols-4"
      onSubmit={onApply}
    >
      <TextField
        label={copy('Search task titles', 'tasks')}
        value={draft.q}
        maxLength={100}
        onChange={(e) => setDraft({ ...draft, q: e.target.value })}
      />
      <TextField
        label={copy('Tag', 'tasks')}
        value={draft.tag}
        maxLength={40}
        onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
      />
      <label className="grid gap-1.5 font-semibold">
        {copy('Task status', 'tasks')}{' '}
        <select
          className="ui-input font-normal"
          value={draft.status}
          onChange={(e) =>
            setDraft({ ...draft, status: e.target.value as Filter['status'] })
          }
        >
          <option value="all">{copy('All states', 'tasks')}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {copy(statusLabels[s], 'tasks')}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        {copy('Priority', 'tasks')}{' '}
        <select
          className="ui-input font-normal"
          value={draft.priority}
          onChange={(e) =>
            setDraft({
              ...draft,
              priority: e.target.value as Filter['priority'],
            })
          }
        >
          <option value="all">{copy('All priorities', 'tasks')}</option>
          {priorities.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        {copy('Assignee', 'tasks')}{' '}
        <select
          className="ui-input font-normal"
          value={draft.assignee}
          onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
        >
          <option value="">{copy('Anyone', 'tasks')}</option>
          <option value={actor}>{copy('Assigned to me', 'tasks')}</option>
          <option value="unassigned">{copy('Unassigned', 'tasks')}</option>
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        {copy('Records', 'tasks')}{' '}
        <select
          className="ui-input font-normal"
          value={draft.archived}
          onChange={(e) =>
            setDraft({
              ...draft,
              archived: e.target.value as Filter['archived'],
            })
          }
        >
          <option value="false">{copy('Active records', 'tasks')}</option>
          <option value="true">{copy('Archived records', 'tasks')}</option>
          <option value="all">{copy('All records', 'tasks')}</option>
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        {copy('Sort', 'tasks')}{' '}
        <select
          className="ui-input font-normal"
          value={draft.sort}
          onChange={(e) =>
            setDraft({ ...draft, sort: e.target.value as Filter['sort'] })
          }
        >
          <option value="id">{copy('ID · ascending', 'tasks')}</option>
          <option value="-id">{copy('ID · descending', 'tasks')}</option>
        </select>
      </label>
      <Button type="submit" className="w-fit">
        {copy('Apply filters', 'tasks')}
      </Button>
    </form>
  )
}
