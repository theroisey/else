import { SelectField } from '../../components/ui'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Table, TextField, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { usePlanning } from './hooks'
import {
  defaultFilter,
  labels,
  planStates,
  milestoneStates,
  pagePath,
} from './models'
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
export function PlanningListPage({
  milestone = false,
}: {
  milestone?: boolean
}) {
  useLocale()
  const { id = '', planID = '' } = useParams()
  const scope: Scope = { clientID: id, ...(milestone ? { planID } : {}) }
  return <PlanningList key={id + ':' + scope.planID} scope={scope} />
}
function PlanningList({ scope }: { scope: Scope }) {
  useLocale()
  const operation = usePlanning(scope)
  const [draft, setDraft] = useState<Filter>(defaultFilter),
    [filter, setFilter] = useState<Filter>(defaultFilter),
    [history, setHistory] = useState(['']),
    [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState('')
  const cursor = history.at(-1) ?? '',
    name = scope.planID
      ? copy('Milestones', 'planning')
      : copy('Plans', 'planning')
  const query = useQuery({
    queryKey: [...operation.key, 'list', scope.planID ?? '', filter, cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.list(scope, filter, cursor, signal)),
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
      <PlanningHeader
        title={
          scope.planID
            ? copy('Milestones', 'planning')
            : copy('Planning', 'planning')
        }
        operation={operation}
      >
        <Button icon={faRotateRight} disabled={busy} onClick={refresh}>
          {copy('Refresh {{value1}}', 'planning', {
            value1: copy(scope.planID ? 'milestones' : 'plans', 'planning'),
          })}
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(scope) + '/new'}
          >
            {copy('Create {{value1}}', 'planning', {
              value1: copy(scope.planID ? 'milestone' : 'plan', 'planning'),
            })}
          </Link>
        ) : null}
      </PlanningHeader>
      {notice ? (
        <p role="status" className="mb-4">
          {copy(notice, 'planning')}
        </p>
      ) : null}
      {!confirm ? (
        <OperationNotice operation={operation} reload={refresh} />
      ) : null}
      <form
        className="mb-5 filter-bar filter-grid planning-filters"
        onSubmit={(e) => {
          e.preventDefault()
          setFilter({ ...draft, q: draft.q.trim() })
          setHistory([''])
          operation.clearError()
        }}
      >
        <TextField
          label={copy('Search {{value1}}', 'planning', {
            value1: copy(scope.planID ? 'milestones' : 'plans', 'planning'),
          })}
          maxLength={200}
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
        />
        <SelectField
          label={copy('State', 'planning')}
          value={draft.status}
          onChange={(e) =>
            setDraft({ ...draft, status: e.target.value as Filter['status'] })
          }
        >
          <option value="all">{copy('All states', 'planning')}</option>
          {(scope.planID ? milestoneStates : planStates).map((s) => (
            <option key={s} value={s}>
              {copy(labels[s], 'planning')}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={copy('Archive', 'planning')}
          value={draft.archived}
          onChange={(e) =>
            setDraft({
              ...draft,
              archived: e.target.value as Filter['archived'],
            })
          }
        >
          <option value="false">{copy('Current', 'planning')}</option>
          <option value="true">{copy('Archived', 'planning')}</option>
          <option value="all">{copy('All records', 'planning')}</option>
        </SelectField>
        <SelectField
          label={copy('Order', 'planning')}
          value={draft.sort}
          onChange={(e) =>
            setDraft({ ...draft, sort: e.target.value as Filter['sort'] })
          }
        >
          <option value="id">{copy('ID ascending', 'planning')}</option>
          <option value="-id">{copy('ID descending', 'planning')}</option>
        </SelectField>
        <div className="filter-actions">
          <Button type="submit" disabled={busy}>
            {copy('Apply filters', 'planning')}
          </Button>
        </div>
      </form>
      {query.isPending ? (
        <p role="status" aria-busy="true">
          {copy('Loading {{value1}}…', 'planning', {
            value1: copy(scope.planID ? 'milestones' : 'plans', 'planning'),
          })}
        </p>
      ) : query.isError ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No {{value1}} on this page', 'planning', {
              value1: copy(scope.planID ? 'milestones' : 'plans', 'planning'),
            })}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Adjust the filters or create a record if you have access.',
              'planning',
            )}
          </p>
        </div>
      ) : (
        <Table
          caption={copy('Client {{value1}}', 'planning', {
            value1: copy(scope.planID ? 'milestones' : 'plans', 'planning'),
          })}
        >
          <thead>
            <tr>
              {[
                scope.planID
                  ? copy('Milestone', 'planning')
                  : copy('Plan', 'planning'),
                copy('State', 'planning'),
                copy('Due', 'planning'),
                copy('Updated', 'planning'),
                copy('Actions', 'planning'),
              ].map((s) => (
                <th key={s} scope="col">
                  {s}
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
                    aria-label={copy('Open {{value1}}', 'planning', {
                      value1: r.title,
                    })}
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
                    <span className="text-xs text-muted">
                      {copy('Updating…', 'planning')}
                    </span>
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
