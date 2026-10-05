import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  const [draft, setDraft] = useState({ ...emptyFilters })
  const [error, setError] = useState('')
  const labels = {
    actor_id: copy('Actor ID', 'audit'),
    event_type: copy('Event type', 'audit'),
    client_id: copy('Client ID', 'audit'),
    resource_kind: copy('Resource kind', 'audit'),
    resource_id: copy('Resource ID', 'audit'),
    request_id: copy('Request ID', 'audit'),
    from: copy('From (UTC, inclusive)', 'audit'),
    to: copy('To (UTC, exclusive)', 'audit'),
  }
  return (
    <form
      className="mb-5 filter-bar"
      aria-label={copy('Audit filters', 'audit')}
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
          {copy('Actor kind', 'audit')}{' '}
          <select
            className="ui-input"
            value={draft.actor_kind}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, actor_kind: e.target.value })}
          >
            <option value="">{copy('All actors', 'audit')}</option>
            <option value="user">{copy('User', 'audit')}</option>
            <option value="system">{copy('System', 'audit')}</option>
          </select>
        </label>
      </div>
      <p className="mt-3 text-xs text-muted">
        {copy(
          'Exact filters. Dates use UTC with up to six fractional digits. Leave a field empty to include all visible matches.',
          'audit',
        )}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger-ink">
          {copy(error, 'audit')}
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={busy}>
          {copy('Apply filters', 'audit')}
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
          {copy('Clear filters', 'audit')}
        </Button>
      </div>
    </form>
  )
}
