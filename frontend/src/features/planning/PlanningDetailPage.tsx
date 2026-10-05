import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { usePlanning } from './hooks'
import { pagePath, recordKey } from './models'
import type { Scope, Summary } from './models'
import {
  PlanningHeader,
  PlanningError,
  PlanningState,
  PlanningTime,
  OperationNotice,
} from './Shared'
import { PlanningActions, PlanningArchive } from './PlanningActions'
import { TaskLinks } from './TaskLinks'
import * as api from './service'
export function PlanningDetailPage({
  milestone = false,
}: {
  milestone?: boolean
}) {
  useLocale()
  const { id = '', planID = '', milestoneID = '' } = useParams()
  const scope: Scope = { clientID: id, ...(milestone ? { planID } : {}) },
    recordID = milestone ? milestoneID : planID
  return (
    <PlanningDetail
      key={id + ':' + planID + ':' + milestoneID}
      scope={scope}
      recordID={recordID}
    />
  )
}
function PlanningDetail({
  scope,
  recordID,
}: {
  scope: Scope
  recordID: string
}) {
  useLocale()
  const operation = usePlanning(scope),
    location = useLocation()
  const [confirm, setConfirm] = useState<Summary | null>(null),
    [notice, setNotice] = useState(''),
    [linksEditing, setLinksEditing] = useState(false)
  const query = useQuery({
    queryKey: [...operation.key, ...recordKey(scope, recordID)],
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(scope, recordID, signal)),
    enabled: operation.permissions.view,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === operation.auth.session?.user.id
        ? previous
        : undefined,
  })
  if (!operation.permissions.view) return <AccessDenied />
  if (query.isPending)
    return (
      <p role="status" aria-busy="true">
        {copy('Loading {{value1}}…', 'planning', {
          value1: copy(scope.planID ? 'milestone' : 'plan', 'planning'),
        })}
      </p>
    )
  if (query.isError && !query.data)
    return (
      <PlanningError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const record = query.data
  if (!record) return null
  const refresh = () => {
    operation.clearError()
    setNotice('')
    void operation.cache.invalidateQueries({ queryKey: operation.key })
  }
  return (
    <section>
      <PlanningHeader title={record.title} operation={operation}>
        <Button
          disabled={query.isFetching || operation.pending}
          onClick={refresh}
        >
          {copy('Refresh {{value1}}', 'planning', {
            value1: copy(scope.planID ? 'milestone' : 'plan', 'planning'),
          })}
        </Button>
        {!scope.planID ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath({ clientID: scope.clientID, planID: record.id })}
          >
            {copy('Open milestones', 'planning')}
          </Link>
        ) : null}
      </PlanningHeader>
      {notice || location.state?.planningSaved ? (
        <p role="status" className="mb-4">
          {notice ||
            (location.state.planningSaved === 'created'
              ? copy('Record created.', 'planning')
              : copy('Record updated.', 'planning'))}
        </p>
      ) : null}
      {!confirm && !linksEditing ? (
        <OperationNotice operation={operation} reload={refresh} />
      ) : null}
      {query.isError ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : null}
      <div className="mb-5">
        <PlanningState record={record} />
      </div>
      {record.archived_at ? (
        <p role="status" className="mb-4">
          {copy(
            'This {{value1}} is archived. Its details and linked history are retained.',
            'planning',
            { value1: copy(scope.planID ? 'milestone' : 'plan', 'planning') },
          )}
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="workspace-section">
          <h2 className="font-semibold">{copy('Description', 'planning')}</h2>
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">
            {record.description || copy('No description provided.', 'planning')}
          </p>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            {(!scope.planID
              ? [
                  [copy('Start', 'planning'), record.start_at],
                  [copy('Due', 'planning'), record.due_at],
                ]
              : [[copy('Due', 'planning'), record.due_at]]
            )
              .concat(
                record.completed_at
                  ? [[copy('Completed', 'planning'), record.completed_at]]
                  : [],
              )
              .concat(
                record.cancelled_at
                  ? [[copy('Cancelled', 'planning'), record.cancelled_at]]
                  : [],
              )
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-1 text-sm">
                    <PlanningTime value={value ?? null} />
                  </dd>
                </div>
              ))}
          </dl>
          {!scope.planID ? (
            <p className="mt-5 text-xs text-muted">
              {copy(
                'Plan completion is a manual decision, independent of milestones and linked tasks.',
                'planning',
              )}
            </p>
          ) : null}
        </section>
        <aside className="context-rail">
          <h2 className="font-semibold">
            {copy('Record context', 'planning')}
          </h2>
          <dl className="mt-4 grid gap-4">
            {[
              [copy('Record ID', 'planning'), record.id],
              [copy('Client ID', 'planning'), scope.clientID],
              [
                copy('Creator', 'planning'),
                record.created_by === operation.auth.session?.user.id
                  ? copy('Me', 'planning')
                  : record.created_by,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 break-all text-xs">{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-muted">
                {copy('Updated', 'planning')}
              </dt>
              <dd className="mt-1 text-xs">
                <PlanningTime value={record.updated_at} />
              </dd>
            </div>
          </dl>
        </aside>
      </div>
      {!query.isFetching && !query.isError && !linksEditing ? (
        <div className="mt-5">
          <PlanningActions
            key={record.id + ':' + record.revision}
            record={record}
            operation={operation}
            onArchive={setConfirm}
            onSuccess={setNotice}
          />
        </div>
      ) : null}
      {scope.planID ? (
        <TaskLinks
          key={record.id}
          record={record}
          operation={operation}
          checking={query.isError || query.isFetching}
          onEditingChange={setLinksEditing}
        />
      ) : null}
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
