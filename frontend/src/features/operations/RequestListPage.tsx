import { ScopeFilters } from './ScopeFilters'
import type { Scope } from './ScopeFilters'
import { time } from './time'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import {
  Button,
  SelectField,
  TextField,
  Table,
  PageSkeleton,
  buttonStyles,
} from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsHeader, OperationsError, RequestState } from './Shared'
import { states, labels } from './models'
import * as api from './service'
export function RequestListPage() {
  useLocale()
  const { id } = useParams()
  return <RequestList key={id ?? 'queue'} client={id} />
}
function RequestList({ client }: { client?: string | undefined }) {
  useLocale()
  const op = useRecordOperations('operations', client)
  const [params] = useSearchParams()
  const [status, setStatus] = useState(
    states.includes(params.get('status') as (typeof states)[number])
      ? params.get('status')!
      : 'all',
  )
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>({
    brand: '',
    website: '',
    employee: '',
  })
  const [priority, setPriority] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [assignee, setAssignee] = useState('')
  const [history, setHistory] = useState([''])
  const cursor = history.at(-1) ?? ''
  const qs = new URLSearchParams({ limit: '25', status })
  if (scope.brand && !client) qs.set('client_id', scope.brand)
  if (scope.website) qs.set('website', scope.website)
  if (scope.employee) qs.set('requester', scope.employee)
  if (priority !== 'all') qs.set('priority', priority)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  if (q) qs.set('q', q)
  if (cursor) qs.set('cursor', cursor)
  if (assignee) qs.set('assignee', assignee)
  const query = useQuery({
    queryKey: [...op.key, 'requests', qs.toString()],
    queryFn: ({ signal }) => op.read(() => api.list(client, qs, signal)),
    refetchInterval: 30_000,
  })
  const grants = op.auth.session?.user.permissions ?? []
  const create = grants.some(
    (g) =>
      g.permission === 'tickets.create' &&
      (g.scope === 'global' || !client || g.client_id === client),
  )
  return (
    <section>
      <OperationsHeader
        title={copy('Technical requests', 'operations')}
        client={client}
      >
        {create ? (
          <Link
            to={
              client
                ? `/app/clients/${client}/requests/new`
                : '/app/requests/new'
            }
            className={buttonStyles({ variant: 'primary' })}
          >
            {copy('New technical request', 'operations')}
          </Link>
        ) : null}
      </OperationsHeader>
      <ScopeFilters
        value={scope}
        fixedBrand={client}
        sites
        onChange={(v) => {
          setScope(v)
          setHistory([''])
        }}
      />
      <details className="mb-5">
        <summary className="cursor-pointer text-sm">
          {copy('Additional filters', 'operations')}
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <SelectField
            label={copy('Priority', 'operations')}
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value)
              setHistory([''])
            }}
          >
            {['all', 'normal', 'high', 'critical'].map((v) => (
              <option key={v} value={v}>
                {copy(
                  v === 'all'
                    ? 'All priorities'
                    : v === 'normal'
                      ? 'Normal priority'
                      : v === 'high'
                        ? 'High priority'
                        : 'Critical',
                  'operations',
                )}
              </option>
            ))}
          </SelectField>
          <TextField
            label={copy('Created from (UTC date)', 'operations')}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setHistory([''])
            }}
          />
          <TextField
            label={copy('Created until (UTC date)', 'operations')}
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              setHistory([''])
            }}
          />
        </div>
      </details>
      <form
        className="mb-6 grid items-end gap-4 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault()
          setHistory([''])
          setQ(search.trim())
        }}
      >
        <TextField
          label={copy('Search requests', 'operations')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
        />
        <SelectField
          label={copy('Status', 'common')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setHistory([''])
          }}
        >
          <option value="all">{copy('All statuses', 'operations')}</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {copy(labels[s], 'operations')}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={copy('Assignment', 'operations')}
          value={assignee}
          onChange={(e) => {
            setAssignee(e.target.value)
            setHistory([''])
          }}
        >
          <option value="">{copy('All assignments', 'operations')}</option>
          <option value="me">{copy('Assigned to me', 'operations')}</option>
          <option value="unassigned">{copy('Unassigned', 'operations')}</option>
        </SelectField>
        <Button type="submit">{copy('Search', 'common')}</Button>
      </form>
      {query.isPending ? (
        <PageSkeleton label={copy('Loading requests…', 'operations')} />
      ) : query.isError ? (
        <OperationsError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : (
        <>
          <Table caption={copy('Technical requests', 'operations')}>
            <thead>
              <tr>
                {[
                  'Request',
                  'Brand / website',
                  'Requester',
                  'Status',
                  'Developer',
                  'Updated',
                ].map((t) => (
                  <th key={t}>{copy(t, 'operations')}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      to={`/app/clients/${r.client_id}/requests/${r.id}`}
                    >
                      {r.title}
                    </Link>
                    <p className="mt-1 text-xs text-muted">
                      {copy(
                        r.priority === 'critical'
                          ? 'Critical'
                          : r.priority === 'high'
                            ? 'High priority'
                            : 'Normal priority',
                        'operations',
                      )}
                    </p>
                  </td>
                  <td>
                    {r.brand_name}
                    <p className="text-xs text-muted">
                      {r.website_domain ?? copy('Brand-wide', 'operations')}
                    </p>
                  </td>
                  <td>{r.requester_name}</td>
                  <td>
                    <RequestState status={r.status} />
                  </td>
                  <td>{r.assignee_name ?? copy('Unassigned', 'operations')}</td>
                  <td className="text-xs">{time(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!query.data.data.length ? (
            <p className="py-8 text-muted">
              {copy('No technical requests match these filters.', 'operations')}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-3">
            <Button
              disabled={history.length < 2 || query.isFetching}
              onClick={() => setHistory((v) => v.slice(0, -1))}
            >
              {copy('Previous', 'common')}
            </Button>
            <Button
              disabled={!query.data.page.next_cursor || query.isFetching}
              onClick={() =>
                setHistory((v) => [...v, query.data.page.next_cursor!])
              }
            >
              {copy('Next', 'common')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
