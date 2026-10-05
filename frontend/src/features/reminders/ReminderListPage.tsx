import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, TextField, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useReminders } from './hooks'
import { defaultFilter, states, labels, pagePath } from './models'
import type { Filter, Summary } from './models'
import { ReminderHeader, ReminderState, ReminderTime, ReminderError, Pager } from './Shared'
import { ReminderActions, ReminderDismiss } from './ReminderActions'
import * as api from './service'
export function ReminderListPage() {
  const { id = '' } = useParams()
  return <List key={id} clientID={id} />
}
function List({ clientID }: { clientID: string }) {
  const operation = useReminders(clientID),
    [draft, setDraft] = useState<Filter>(defaultFilter),
    [filter, setFilter] = useState<Filter>(defaultFilter),
    [history, setHistory] = useState(['']),
    [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const query = useQuery({
    queryKey: [...operation.key, 'list', filter, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() => api.list(clientID, filter, history.at(-1) ?? '', signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  const busy = query.isFetching || operation.pending,
    refresh = () => {
      operation.clearError()
      setNotice('')
      void operation.cache.invalidateQueries({ queryKey: operation.key })
    }
  return (
    <section>
      <ReminderHeader title="Reminders" operation={operation}>
        <Button icon={faRotateRight} disabled={busy} onClick={refresh}>
          Refresh reminders
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link className={buttonStyles({ variant: 'primary' })} to={pagePath(clientID) + '/new'}>
            Create reminder
          </Link>
        ) : null}
      </ReminderHeader>
      {notice ? (
        <p role="status" className="mb-4">
          {notice}
        </p>
      ) : null}
      {!confirm && operation.error ? (
        <div className="mb-4">
          <p role="alert" className="text-danger-ink">
            {operation.error}
          </p>
          <Button className="mt-2" onClick={refresh}>
            Reload current data
          </Button>
        </div>
      ) : null}
      <form
        className="mb-5 grid gap-3 filter-bar sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault()
          setFilter({ ...draft, q: draft.q.trim(), owner: draft.owner.trim() || 'any' })
          setHistory([''])
          operation.clearError()
        }}
      >
        <TextField
          label="Search reminders"
          maxLength={200}
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          State
          <select
            className="ui-input"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as Filter['status'] })}
          >
            <option value="all">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          Schedule view
          <select
            className="ui-input"
            value={draft.due}
            onChange={(e) => setDraft({ ...draft, due: e.target.value as Filter['due'] })}
          >
            <option value="all">All schedules</option>
            <option value="due">Due pending reminders</option>
            <option value="upcoming">Upcoming pending reminders</option>
          </select>
        </label>
        <TextField
          label="Owner filter"
          description="any, me, or an owner ID, including historical owners"
          value={draft.owner}
          onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          Order
          <select
            className="ui-input"
            value={draft.sort}
            onChange={(e) => setDraft({ ...draft, sort: e.target.value as Filter['sort'] })}
          >
            <option value="id">ID ascending</option>
            <option value="-id">ID descending</option>
          </select>
        </label>
        <Button type="submit" className="self-end" disabled={busy}>
          Apply filters
        </Button>
      </form>
      {query.isPending ? (
        <PageSkeleton label="Loading reminders…" />
      ) : query.isError ? (
        <ReminderError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">No reminders on this page</h2>
          <p className="mt-2 text-muted">
            Adjust the filters or create a reminder if you have access.
          </p>
        </div>
      ) : (
        <Table caption="Client reminders">
          <thead>
            <tr>
              {['Reminder', 'State', 'Schedule', 'Owner', 'Actions'].map((v) => (
                <th key={v} scope="col">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((r) => (
              <tr key={r.id}>
                <td className="min-w-48 max-w-80">
                  <Link
                    className="break-words font-semibold underline underline-offset-4"
                    aria-label={`Open ${r.title}`}
                    to={pagePath(clientID, r.id)}
                  >
                    {r.title}
                  </Link>
                </td>
                <td>
                  <ReminderState record={r} />
                </td>
                <td className="min-w-48 text-xs">
                  <ReminderTime record={r} />
                </td>
                <td className="min-w-32 max-w-48 break-all text-xs">
                  {r.owner_id === operation.auth.session?.user.id ? 'Me' : r.owner_id}
                </td>
                <td>
                  {!busy ? (
                    <ReminderActions
                      record={r}
                      operation={operation}
                      onDismiss={setConfirm}
                      onSuccess={setNotice}
                    />
                  ) : (
                    <span className="text-xs text-muted">Updating…</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        name="Reminders"
        history={history}
        next={query.isError ? null : query.data?.page.next_cursor}
        busy={busy}
        onChange={setHistory}
      />
      {confirm && operation.permissions.update && operation.writable ? (
        <ReminderDismiss
          record={confirm}
          operation={operation}
          onClose={() => setConfirm(null)}
          onSuccess={() => {
            setConfirm(null)
            setNotice('Reminder dismissed.')
          }}
        />
      ) : null}
    </section>
  )
}
