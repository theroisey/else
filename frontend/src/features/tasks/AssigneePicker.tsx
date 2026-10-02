import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '../../components/ui'
import type { useTasks } from './hooks'
import { TaskError } from './Shared'
import * as api from './service'

export function AssigneePicker({
  clientID,
  operation,
  value,
  onChange,
  disabled,
  error,
}: {
  clientID: string
  operation: ReturnType<typeof useTasks>
  value: string
  onChange: (id: string) => void
  disabled: boolean
  error: string
}) {
  const [history, setHistory] = useState(['']),
    cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'candidates', cursor],
    queryFn: ({ signal }) => operation.read(() => api.candidates(clientID, cursor, signal)),
    enabled: operation.permissions.create || operation.permissions.update,
  })
  const candidates = query.isError ? [] : (query.data?.data ?? [])
  return (
    <div className="grid gap-2">
      <label className="font-semibold" htmlFor="task-assignee">
        Assignee
      </label>
      <p id="task-assignee-help" className="text-xs text-muted">
        Choose someone with task access for this client. Existing assignments remain until you
        explicitly change them.
      </p>
      <select
        id="task-assignee"
        className="ui-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || query.isFetching}
        aria-invalid={!!error}
        aria-describedby="task-assignee-help task-assignee-error"
      >
        <option value="">Unassigned</option>
        {value && !candidates.some((c) => c.id === value) ? (
          <option value={value}>Selected assignee · {value.slice(0, 8)}</option>
        ) : null}
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.display_name}
          </option>
        ))}
      </select>
      {error ? (
        <p id="task-assignee-error" role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status">Loading eligible assignees…</p>
      ) : query.isError ? (
        <TaskError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : null}
      <nav aria-label="Assignee pagination" className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted">Up to 25 eligible assignees per page</p>
        <Button
          size="compact"
          disabled={disabled || query.isFetching || history.length < 2}
          onClick={() => setHistory((h) => h.slice(0, -1))}
        >
          Previous assignees
        </Button>
        <Button
          size="compact"
          disabled={disabled || query.isFetching || query.isError || !query.data?.page.next_cursor}
          onClick={() => {
            if (query.data?.page.next_cursor)
              setHistory((h) => [...h, query.data.page.next_cursor!])
          }}
        >
          Next assignees
        </Button>
      </nav>
    </div>
  )
}
