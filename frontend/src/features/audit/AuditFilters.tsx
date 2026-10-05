import { useState } from 'react'
import { Button, TextField } from '../../components/ui'
import { emptyFilters, validateFilters } from './models'
import type { Filters } from './models'
export function AuditFilters({
  scope,
  busy,
  onApply,
}: {
  scope: string | undefined
  busy: boolean
  onApply: (f: Filters) => void
}) {
  const [draft, setDraft] = useState({ ...emptyFilters })
  const [error, setError] = useState('')
  const labels = {
    actor_id: 'Actor ID',
    event_type: 'Event type',
    client_id: 'Client ID',
    resource_kind: 'Resource kind',
    resource_id: 'Resource ID',
    request_id: 'Request ID',
    from: 'From (UTC, inclusive)',
    to: 'To (UTC, exclusive)',
  }
  return (
    <form
      className="mb-5 filter-bar"
      aria-label="Audit filters"
      onSubmit={(e) => {
        e.preventDefault()
        try {
          onApply(validateFilters(draft, scope))
          setError('')
        } catch {
          setError(
            'Check UUIDs, event type, request ID and UTC dates. From must be earlier than To.',
          )
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(labels)
          .filter(([key]) => !scope || key !== 'client_id')
          .map(([key, label]) => (
            <TextField
              key={key}
              label={label}
              value={draft[key as keyof Filters]}
              disabled={busy}
              maxLength={
                key === 'event_type'
                  ? 64
                  : key === 'resource_kind'
                    ? 32
                    : key === 'request_id'
                      ? 26
                      : 36
              }
              placeholder={
                key === 'from' || key === 'to'
                  ? '2026-10-02T12:00:00.123456Z'
                  : key === 'event_type'
                    ? 'task.updated'
                    : key === 'resource_kind'
                      ? 'task'
                      : undefined
              }
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          ))}
        <label className="grid content-start gap-1.5 text-sm font-semibold">
          Actor kind
          <select
            className="ui-input"
            value={draft.actor_kind}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, actor_kind: e.target.value })}
          >
            <option value="">All actors</option>
            <option value="user">User</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-muted">
        Exact filters. Dates use UTC with up to six fractional digits. Leave a
        field empty to include all visible matches.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger-ink">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={busy}>
          Apply filters
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            setDraft({ ...emptyFilters })
            setError('')
            onApply({ ...emptyFilters })
          }}
        >
          Clear filters
        </Button>
      </div>
    </form>
  )
}
