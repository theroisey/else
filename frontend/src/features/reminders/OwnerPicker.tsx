import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '../../components/ui'
import { ReminderError } from './Shared'
import type { Operation } from './Shared'
import * as api from './service'
export function OwnerPicker({
  operation,
  value,
  onChange,
  disabled,
  error,
}: {
  operation: Operation
  value: string
  onChange: (id: string) => void
  disabled: boolean
  error: string
}) {
  useLocale()
  const [history, setHistory] = useState(['']),
    cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'owners', cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.owners(operation.clientID, cursor, signal)),
    enabled:
      !disabled &&
      operation.writable &&
      (operation.permissions.create || operation.permissions.update),
  })
  const candidates = query.isError ? [] : (query.data?.data ?? [])
  return (
    <div className="grid gap-2">
      <label className="font-semibold" htmlFor="reminder-owner">
        {copy('Owner', 'reminders')}
      </label>
      <p id="reminder-owner-help" className="text-xs text-muted">
        {copy(
          'Choose someone with reminder access for this client. Recorded ownership is retained until you change it.',
          'reminders',
        )}
      </p>
      <select
        id="reminder-owner"
        className="ui-input"
        value={value}
        disabled={disabled || query.isFetching || query.isError}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby="reminder-owner-help reminder-owner-error"
      >
        {value && !candidates.some((c) => c.id === value) ? (
          <option value={value}>
            {value === operation.auth.session?.user.id
              ? copy('Me', 'reminders')
              : copy('Recorded owner', 'reminders')}{' '}
            · {value}
          </option>
        ) : null}
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.display_name}
          </option>
        ))}
      </select>
      {error ? (
        <p
          id="reminder-owner-error"
          role="alert"
          className="text-xs text-danger-ink"
        >
          {copy(error, 'reminders')}
        </p>
      ) : null}
      {query.isPending && operation.writable && !disabled ? (
        <p role="status">{copy('Loading eligible owners…', 'reminders')}</p>
      ) : query.isError ? (
        <ReminderError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : null}
      <nav
        aria-label={copy('Owner pagination', 'reminders')}
        className="flex flex-wrap items-center gap-2"
      >
        <p className="mr-auto text-xs text-muted">
          {copy('Up to 25 eligible owners per page', 'reminders')}
        </p>
        <Button
          size="compact"
          disabled={disabled || query.isFetching || history.length < 2}
          onClick={() => setHistory((h) => h.slice(0, -1))}
        >
          {copy('Previous owners', 'reminders')}
        </Button>
        <Button
          size="compact"
          disabled={
            disabled ||
            query.isFetching ||
            query.isError ||
            !query.data?.page.next_cursor
          }
          onClick={() => {
            if (query.data?.page.next_cursor)
              setHistory((h) => [...h, query.data.page.next_cursor!])
          }}
        >
          {copy('Next owners', 'reminders')}
        </Button>
      </nav>
    </div>
  )
}
