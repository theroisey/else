import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  const [kind, setKind] = useState<Resource['kind']>(value?.kind ?? 'task'),
    [parent, setParent] = useState(''),
    [history, setHistory] = useState(['']),
    [draft, setDraft] = useState(''),
    [search, setSearch] = useState('')
  const allowed =
      kind === 'task'
        ? operation.permissions.taskView
        : operation.permissions.planningView,
    cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'resources', kind, parent, search, cursor],
    queryFn: ({ signal }) =>
      operation.read(async () => {
        if (kind === 'task')
          return tasks.list(
            operation.clientID,
            { ...taskFilter, q: search },
            cursor,
            signal,
          )
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
      <h2 className="font-semibold">
        {copy('Resource reference', 'reminders')}
      </h2>
      <p className="break-all text-xs">
        {value
          ? `${statusLabel(value.kind)} · ${value.id}`
          : copy('No resource linked.', 'reminders')}
      </p>
      <p className="text-xs text-muted">
        {copy(
          'References retain IDs. New links require independent access; existing references can be retained or cleared.',
          'reminders',
        )}
      </p>
      {value ? (
        <Button
          className="justify-self-start"
          size="compact"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          {copy('Clear reference', 'reminders')}
        </Button>
      ) : null}
      {operation.permissions.taskView || operation.permissions.planningView ? (
        <>
          <label className="grid gap-1.5 text-sm font-semibold">
            {copy('Browse resources', 'reminders')}{' '}
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
                <option value={kind}>
                  {copy(
                    'Recorded {{value1}} · browse access unavailable',
                    'reminders',
                    { value1: statusLabel(kind) },
                  )}
                </option>
              ) : null}
              {operation.permissions.taskView ? (
                <option value="task">{copy('Tasks', 'reminders')}</option>
              ) : null}
              {operation.permissions.planningView ? (
                <>
                  <option value="plan">{copy('Plans', 'reminders')}</option>
                  <option value="milestone">
                    {copy('Milestones', 'reminders')}
                  </option>
                </>
              ) : null}
            </select>
          </label>
          {allowed ? (
            <>
              {kind === 'milestone' ? (
                <p className="break-all text-xs">
                  {parent
                    ? copy('Parent plan · {{value1}}', 'reminders', {
                        value1: parent,
                      })
                    : copy(
                        'Choose a parent plan, then a milestone.',
                        'reminders',
                      )}
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
                  {copy('Choose another parent plan', 'reminders')}
                </Button>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <TextField
                  label={copy('Search resources', 'reminders')}
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
                  {copy('Search references', 'reminders')}
                </Button>
              </div>
              {query.isPending ? (
                <p role="status">
                  {copy('Loading eligible resources…', 'reminders')}
                </p>
              ) : query.isError ? (
                <ReminderError
                  error={query.error}
                  retry={() => {
                    void query.refetch()
                  }}
                />
              ) : !candidates.length ? (
                <p role="status">
                  {copy('No eligible resources on this page.', 'reminders')}
                </p>
              ) : (
                <ul className="grid gap-2">
                  {candidates.map((c) => (
                    <li
                      key={c.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3"
                    >
                      <span className="min-w-0 break-words text-sm">
                        {c.title}
                      </span>
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
                        {kind === 'milestone' && !parent
                          ? copy('Open milestones', 'reminders')
                          : copy('Select reference', 'reminders')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <Pager
                name={copy('Resources', 'reminders')}
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
          {copy(
            'Resource browsing requires task or planning view for this client.',
            'reminders',
          )}
        </p>
      )}
    </div>
  )
}
