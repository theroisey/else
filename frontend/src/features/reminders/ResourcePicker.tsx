import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, TextField } from '../../components/ui'
import { ReminderError, Pager } from './Shared'
import type { Operation } from './Shared'
import type { Resource } from './models'
import * as tasks from '../tasks/service'
import { defaultFilter as taskFilter } from '../tasks/models'
import * as planning from '../planning/service'
import { defaultFilter as planFilter } from '../planning/models'
export function ResourcePicker({
  operation,
  value,
  onChange,
  disabled,
}: {
  operation: Operation
  value: Resource | null
  onChange: (value: Resource | null) => void
  disabled: boolean
}) {
  const [kind, setKind] = useState<Resource['kind']>(value?.kind ?? 'task'),
    [parent, setParent] = useState(''),
    [history, setHistory] = useState(['']),
    [draft, setDraft] = useState(''),
    [search, setSearch] = useState('')
  const allowed =
      kind === 'task' ? operation.permissions.taskView : operation.permissions.planningView,
    cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'resources', kind, parent, search, cursor],
    queryFn: ({ signal }) =>
      operation.read(async () => {
        if (kind === 'task')
          return tasks.list(operation.clientID, { ...taskFilter, q: search }, cursor, signal)
        return planning.list(
          {
            clientID: operation.clientID,
            ...(kind === 'milestone' && parent ? { planID: parent } : {}),
          },
          { ...planFilter, q: search },
          cursor,
          signal,
        )
      }),
    enabled: allowed && operation.writable && !disabled,
  })
  const candidates = allowed && !query.isError ? (query.data?.data ?? []) : []
  const reset = () => {
    setHistory([''])
    setDraft('')
    setSearch('')
  }
  return (
    <div className="grid min-w-0 gap-3 rounded-md border border-line p-4">
      <h2 className="font-semibold">Resource reference</h2>
      <p className="break-all text-xs">
        {value ? `${value.kind} · ${value.id}` : 'No resource linked.'}
      </p>
      <p className="text-xs text-muted">
        References retain IDs. New links require independent access; existing references can be
        retained or cleared.
      </p>
      {value ? (
        <Button
          className="justify-self-start"
          size="compact"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Clear reference
        </Button>
      ) : null}
      {operation.permissions.taskView || operation.permissions.planningView ? (
        <>
          <label className="grid gap-1.5 text-sm font-semibold">
            Browse resources
            <select
              className="ui-input"
              value={kind}
              disabled={disabled}
              onChange={(e) => {
                setKind(e.target.value as Resource['kind'])
                setParent('')
                reset()
              }}
            >
              {!allowed ? (
                <option value={kind}>Recorded {kind} · browse access unavailable</option>
              ) : null}
              {operation.permissions.taskView ? <option value="task">Tasks</option> : null}
              {operation.permissions.planningView ? (
                <>
                  <option value="plan">Plans</option>
                  <option value="milestone">Milestones</option>
                </>
              ) : null}
            </select>
          </label>
          {allowed ? (
            <>
              {kind === 'milestone' ? (
                <p className="break-all text-xs">
                  {parent ? `Parent plan · ${parent}` : 'Choose a parent plan, then a milestone.'}
                </p>
              ) : null}
              {parent ? (
                <Button
                  size="compact"
                  disabled={disabled}
                  onClick={() => {
                    setParent('')
                    reset()
                  }}
                >
                  Choose another parent plan
                </Button>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <TextField
                  label="Search resources"
                  value={draft}
                  maxLength={200}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button
                  disabled={disabled || query.isFetching}
                  onClick={() => {
                    setSearch(draft.trim())
                    setHistory([''])
                  }}
                >
                  Search references
                </Button>
              </div>
              {query.isPending ? (
                <p role="status">Loading eligible resources…</p>
              ) : query.isError ? (
                <ReminderError
                  error={query.error}
                  retry={() => {
                    void query.refetch()
                  }}
                />
              ) : !candidates.length ? (
                <p role="status">No eligible resources on this page.</p>
              ) : (
                <ul className="grid gap-2">
                  {candidates.map((c) => (
                    <li
                      key={c.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3"
                    >
                      <span className="min-w-0 break-words text-sm">{c.title}</span>
                      <Button
                        size="compact"
                        disabled={disabled || query.isFetching}
                        onClick={() => {
                          if (kind === 'milestone' && !parent) {
                            setParent(c.id)
                            reset()
                          } else onChange({ kind, id: c.id })
                        }}
                      >
                        {kind === 'milestone' && !parent ? 'Open milestones' : 'Select reference'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Pager
                name="Resources"
                history={history}
                next={query.isError ? null : query.data?.page.next_cursor}
                busy={disabled || query.isFetching}
                onChange={setHistory}
              />
            </>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted">
          Resource browsing requires task or planning view for this client.
        </p>
      )}
    </div>
  )
}
