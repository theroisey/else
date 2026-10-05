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
  return (
    <form
      className="mb-5 grid items-end gap-3 filter-bar sm:grid-cols-2 xl:grid-cols-4"
      onSubmit={onApply}
    >
      <TextField
        label="Search task titles"
        value={draft.q}
        maxLength={100}
        onChange={(e) => setDraft({ ...draft, q: e.target.value })}
      />
      <TextField
        label="Tag"
        value={draft.tag}
        maxLength={40}
        onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
      />
      <label className="grid gap-1.5 font-semibold">
        Task status
        <select
          className="ui-input font-normal"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as Filter['status'] })}
        >
          <option value="all">All states</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        Priority
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
          <option value="all">All priorities</option>
          {priorities.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        Assignee
        <select
          className="ui-input font-normal"
          value={draft.assignee}
          onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
        >
          <option value="">Anyone</option>
          <option value={actor}>Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        Records
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
          <option value="false">Active records</option>
          <option value="true">Archived records</option>
          <option value="all">All records</option>
        </select>
      </label>
      <label className="grid gap-1.5 font-semibold">
        Sort
        <select
          className="ui-input font-normal"
          value={draft.sort}
          onChange={(e) => setDraft({ ...draft, sort: e.target.value as Filter['sort'] })}
        >
          <option value="id">ID · ascending</option>
          <option value="-id">ID · descending</option>
        </select>
      </label>
      <Button type="submit" className="w-fit">
        Apply filters
      </Button>
    </form>
  )
}
