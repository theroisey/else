import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Table, TextField, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { usePlanning } from './hooks'
import { defaultFilter, labels, planStates, milestoneStates, pagePath } from './models'
import type { Filter, Scope, Summary } from './models'
import {
  PlanningHeader,
  PlanningError,
  PlanningState,
  PlanningTime,
  Pager,
  OperationNotice,
} from './Shared'
import { PlanningActions, PlanningArchive } from './PlanningActions'
import * as api from './service'
export function PlanningListPage({ milestone = false }: { milestone?: boolean }) {
  const { id = '', planID = '' } = useParams()
  const scope: Scope = { clientID: id, ...(milestone ? { planID } : {}) }
  return <PlanningList key={id + ':' + scope.planID} scope={scope} />
}
function PlanningList({ scope }: { scope: Scope }) {
  const operation = usePlanning(scope)
  const [draft, setDraft] = useState<Filter>(defaultFilter),
    [filter, setFilter] = useState<Filter>(defaultFilter),
    [history, setHistory] = useState(['']),
    [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const cursor = history.at(-1) ?? '',
    name = scope.planID ? 'Milestones' : 'Plans'
  const query = useQuery({
    queryKey: [...operation.key, 'list', scope.planID ?? '', filter, cursor],
    queryFn: ({ signal }) => operation.read(() => api.list(scope, filter, cursor, signal)),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  const busy = query.isFetching || operation.pending
  const refresh = () => {
    operation.clearError()
    setNotice('')
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  return (
    <section>
      <PlanningHeader title={scope.planID ? 'Milestones' : 'Planning'} operation={operation}>
        <Button icon={faRotateRight} disabled={busy} onClick={refresh}>
          Refresh {name.toLowerCase()}
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link className={buttonStyles({ variant: 'primary' })} to={pagePath(scope) + '/new'}>
            Create {scope.planID ? 'milestone' : 'plan'}
          </Link>
        ) : null}
      </PlanningHeader>
      {notice ? (
        <p role="status" className="mb-4">
          {notice}
        </p>
      ) : null}
      {!confirm ? <OperationNotice operation={operation} reload={refresh} /> : null}
      <form
        className="mb-5 grid gap-3 rounded-md border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault()
          setFilter({ ...draft, q: draft.q.trim() })
          setHistory([''])
          operation.clearError()
        }}
      >
        <TextField
          label={`Search ${name.toLowerCase()}`}
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
            {(scope.planID ? milestoneStates : planStates).map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          Archive
          <select
            className="ui-input"
            value={draft.archived}
            onChange={(e) => setDraft({ ...draft, archived: e.target.value as Filter['archived'] })}
          >
            <option value="false">Current</option>
            <option value="true">Archived</option>
            <option value="all">All records</option>
          </select>
        </label>
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
        <p role="status" aria-busy="true">
          Loading {name.toLowerCase()}…
        </p>
      ) : query.isError ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <div className="rounded-md border border-line bg-surface p-6">
          <h2 className="font-semibold">No {name.toLowerCase()} on this page</h2>
          <p className="mt-2 text-muted">
            Adjust the filters or create a record if you have access.
          </p>
        </div>
      ) : (
        <Table caption={`Client ${name.toLowerCase()}`}>
          <thead>
            <tr>
              {[scope.planID ? 'Milestone' : 'Plan', 'State', 'Due', 'Updated', 'Actions'].map(
                (s) => (
                  <th key={s} scope="col">
                    {s}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((r) => (
              <tr key={r.id}>
                <td className="min-w-48 max-w-80">
                  <Link
                    className="break-words font-semibold underline underline-offset-4"
                    aria-label={`Open ${r.title}`}
                    to={pagePath(scope, r.id)}
                  >
                    {r.title}
                  </Link>
                </td>
                <td>
                  <PlanningState record={r} />
                </td>
                <td className="min-w-40 text-xs">
                  <PlanningTime value={r.due_at} />
                </td>
                <td className="min-w-40 text-xs">
                  <PlanningTime value={r.updated_at} />
                </td>
                <td>
                  {!busy ? (
                    <PlanningActions
                      key={r.id + ':' + r.revision}
                      record={r}
                      operation={operation}
                      onArchive={setConfirm}
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
        name={name}
        history={history}
        next={!query.isError ? query.data?.page.next_cursor : null}
        busy={busy}
        onChange={setHistory}
      />
      {confirm && operation.permissions.archive && operation.writable ? (
        <PlanningArchive
          record={confirm}
          operation={operation}
          onClose={() => setConfirm(null)}
          onSuccess={() => {
            setConfirm(null)
            setNotice('Record archived.')
          }}
        />
      ) : null}
    </section>
  )
}
