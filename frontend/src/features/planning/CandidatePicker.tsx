import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, TextField } from '../../components/ui'
import { Pager, PlanningError } from './Shared'
import type { Operation } from './Shared'
import * as api from './service'

export function CandidatePicker({
  operation,
  selected,
  onChange,
  disabled,
}: {
  operation: Operation
  selected: string[]
  onChange: (ids: string[]) => void
  disabled: boolean
}) {
  const [draft, setDraft] = useState(''),
    [search, setSearch] = useState(''),
    [history, setHistory] = useState([''])
  const cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'task-candidates', operation.scope.planID, search, cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.candidates(operation.scope, cursor, search, signal)),
    enabled:
      operation.permissions.taskView &&
      operation.permissions.update &&
      operation.writable &&
      !disabled,
  })
  return (
    <section className="min-w-0">
      <h3 className="font-semibold">Add tasks from this client</h3>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label="Search task candidates"
            maxLength={200}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <Button
          disabled={disabled || query.isFetching}
          onClick={() => {
            setSearch(draft.trim())
            setHistory([''])
          }}
        >
          Search tasks
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="mt-3" aria-busy="true">
          Loading task candidates…
        </p>
      ) : query.isError ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <p role="status" className="mt-3">
          No eligible tasks on this page.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2" aria-label="Task candidates">
          {query.data.data.map((t) => (
            <li key={t.id}>
              <label className="flex min-w-0 items-start gap-3 rounded-sm border border-line p-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-ink"
                  checked={selected.includes(t.id)}
                  disabled={
                    disabled ||
                    query.isFetching ||
                    (selected.length >= 50 && !selected.includes(t.id))
                  }
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id),
                    )
                  }
                />
                <span className="min-w-0 break-words text-sm">
                  {t.title}
                  <span className="mt-1 block text-xs text-muted">
                    {t.status.replaceAll('_', ' ')} · {t.id}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <Pager
        name="Task candidates"
        history={history}
        next={!query.isError ? query.data?.page.next_cursor : null}
        busy={disabled || query.isFetching}
        onChange={setHistory}
      />
    </section>
  )
}
