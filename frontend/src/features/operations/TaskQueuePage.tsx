import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  SelectField,
  TextField,
  Table,
  PageSkeleton,
} from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { statusLabel } from '../../i18n/labels'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { parsePage, statuses } from '../tasks/models'
import { OperationsHeader, OperationsError } from './Shared'
import { ScopeFilters } from './ScopeFilters'
import type { Scope } from './ScopeFilters'
import { time } from './time'
export function TaskQueuePage() {
  useLocale()
  const op = useRecordOperations('tasks')
  const t = (s: string) => copy(s, 'operations')
  const [scope, setScope] = useState<Scope>({
    brand: '',
    website: '',
    employee: '',
  })
  const [cursor, setCursor] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [mine, setMine] = useState(false)
  const [overdue, setOverdue] = useState(false)
  const params = new URLSearchParams({ limit: '25', status })
  if (cursor) params.set('cursor', cursor)
  if (search.trim()) params.set('q', search.trim())
  if (scope.brand) params.set('client_id', scope.brand)
  if (scope.employee) params.set('assignee', scope.employee)
  else if (mine) params.set('assignee', 'me')
  if (overdue) params.set('overdue', 'true')
  const q = useQuery({
    queryKey: [...op.key, 'queue', params.toString()],
    queryFn: ({ signal }) =>
      op.read(async () => {
        const r = parsePage(
          await authenticatedJSON(`/api/v1/tasks?${params}`, { signal }),
        )
        if (
          r.page.limit !== 25 ||
          r.data.some(
            (v, i) =>
              (scope.brand && v.client_id !== scope.brand) ||
              (cursor && v.id <= cursor) ||
              (i > 0 && v.id <= r.data[i - 1]!.id),
          )
        )
          throw new APIError(0, 'invalid_response')
        return r
      }),
    refetchInterval: 30000,
  })
  return (
    <section>
      <OperationsHeader title={t('Task queue')} />
      <ScopeFilters
        value={scope}
        onChange={(v) => {
          setScope(v)
          setCursor('')
        }}
      />
      <div className="mb-6 grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label={t('Search tasks')}
          maxLength={100}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setCursor('')
          }}
        />
        <SelectField
          label={t('Status')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setCursor('')
          }}
        >
          <option value="active">{t('Active work')}</option>
          <option value="all">{t('All statuses')}</option>
          {statuses.map((v) => (
            <option key={v} value={v}>
              {statusLabel(v)}
            </option>
          ))}
        </SelectField>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => {
              setMine(e.target.checked)
              setScope({ ...scope, employee: '' })
              setCursor('')
            }}
          />
          {t('Assigned to me')}
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={overdue}
            onChange={(e) => {
              setOverdue(e.target.checked)
              setCursor('')
            }}
          />
          {t('Overdue only')}
        </label>
      </div>
      {q.isPending ? (
        <PageSkeleton label={t('Loading daily work…')} />
      ) : q.isError ? (
        <OperationsError
          error={q.error}
          retry={() => {
            void q.refetch()
          }}
        />
      ) : (
        <>
          <Table caption={t('Task queue')}>
            <thead>
              <tr>
                {['Task title', 'Brand', 'Assignee', 'Status', 'Due'].map(
                  (s) => (
                    <th key={s}>{t(s)}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {q.data.data.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link
                      className="font-medium underline underline-offset-4"
                      to={`/app/clients/${v.client_id}/tasks/${v.id}`}
                    >
                      {v.title}
                    </Link>
                  </td>
                  <td>{v.brand_name}</td>
                  <td>{v.assignee_name ?? t('Unassigned')}</td>
                  <td>{statusLabel(v.status)}</td>
                  <td>{time(v.due_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!q.data.data.length ? (
            <p className="py-6 text-muted">
              {t('No tasks match these filters.')}
            </p>
          ) : null}
          <div className="mt-5 flex gap-3">
            {cursor ? (
              <Button onClick={() => setCursor('')}>{t('First page')}</Button>
            ) : null}
            {q.data.page.next_cursor ? (
              <Button onClick={() => setCursor(q.data.page.next_cursor!)}>
                {t('Next page')}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}
