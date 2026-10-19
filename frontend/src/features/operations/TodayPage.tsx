import { time } from './time'
import { useState } from 'react'
import { ScopeFilters } from './ScopeFilters'
import type { Scope } from './ScopeFilters'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import { PageSkeleton, buttonStyles } from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { money } from '../billing/money'
import { OperationsHeader, OperationsError, RequestState } from './Shared'
import { labels, states } from './models'
import * as api from './service'
export function TodayPage() {
  useLocale()
  const op = useRecordOperations('operations')
  const grants = op.auth.session?.user.permissions ?? []
  const [scope, setScope] = useState<Scope>({
    brand: '',
    website: '',
    employee: '',
  })
  const filters = new URLSearchParams()
  if (scope.brand) filters.set('client_id', scope.brand)
  if (scope.employee) filters.set('employee_id', scope.employee)
  const query = useQuery({
    queryKey: [...op.key, 'today', filters.toString()],
    queryFn: ({ signal }) => op.read(() => api.today(signal, filters)),
    refetchInterval: 30_000,
  })
  if (query.isPending)
    return <PageSkeleton label={copy('Loading daily work…', 'operations')} />
  if (query.isError)
    return (
      <OperationsError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const v = query.data
  const canCreate = grants.some((g) => g.permission === 'tickets.create')
  return (
    <section>
      <OperationsHeader title={copy('Today', 'operations')}>
        <Link
          to="/app/requests"
          className={buttonStyles({ variant: 'secondary' })}
        >
          {copy('Open work queue', 'operations')}
        </Link>
        {canCreate ? (
          <Link
            to="/app/requests/new"
            className={buttonStyles({ variant: 'primary' })}
          >
            {copy('New technical request', 'operations')}
          </Link>
        ) : null}
      </OperationsHeader>
      <ScopeFilters value={scope} onChange={setScope} />
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <div className="flex flex-wrap gap-x-8 gap-y-4 border-y border-line py-5">
            {states
              .filter((s) => !['approved', 'cancelled', 'rejected'].includes(s))
              .map((s) => (
                <Link
                  key={s}
                  to={`/app/requests?status=${s}`}
                  className="min-w-24"
                >
                  <span className="block font-display text-3xl tabular-nums">
                    {v.request_counts[s]}
                  </span>
                  <span className="text-xs text-muted">
                    {copy(labels[s], 'operations')}
                  </span>
                </Link>
              ))}
          </div>
          <section className="workspace-section mt-8">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-display text-2xl">
                {copy('Work requiring attention', 'operations')}
              </h2>
              <Link
                to="/app/requests"
                className="text-sm underline underline-offset-4"
              >
                {copy('View all requests', 'operations')}
              </Link>
            </div>
            {v.requests.items.length ? (
              v.requests.items.map((r) => (
                <Link
                  key={r.id}
                  to={`/app/clients/${r.client_id}/requests/${r.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">{r.title}</p>
                    <p className="mt-1 text-xs text-muted">
                      {r.brand_name} · {r.requester_name}
                    </p>
                  </div>
                  <RequestState status={r.status} />
                </Link>
              ))
            ) : (
              <p className="py-6 text-muted">
                {copy('No requests require attention.', 'operations')}
              </p>
            )}
          </section>
          <section className="workspace-section mt-8">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-display text-2xl">
                {copy('My upcoming work', 'operations')}
              </h2>
              <Link
                to="/app/tasks"
                className="text-sm underline underline-offset-4"
              >
                {copy('View all tasks', 'operations')}
              </Link>
              <span className="text-sm text-danger-ink">
                {copy('{{count}} overdue tasks', 'operations', {
                  count: v.overdue_tasks,
                })}
              </span>
            </div>
            {v.tasks.items.length ? (
              v.tasks.items.map((t) => (
                <Link
                  key={t.id}
                  to={`/app/clients/${t.client_id}/tasks/${t.id}`}
                  className="flex flex-wrap justify-between gap-3 border-b border-line py-4"
                >
                  <div>
                    <p className="break-words font-medium">{t.title}</p>
                    <p className="mt-1 text-xs text-muted">
                      {t.brand_name}
                      {t.assignee_name ? ' · ' + t.assignee_name : ''}
                    </p>
                  </div>
                  <time
                    className="text-xs text-muted"
                    dateTime={t.due_at ?? undefined}
                  >
                    {time(t.due_at)}
                  </time>
                </Link>
              ))
            ) : (
              <p className="py-6 text-muted">
                {copy('No work is assigned for today.', 'operations')}
              </p>
            )}
          </section>
          {v.reminders.items.length ? (
            <section className="workspace-section mt-8">
              <h2 className="font-display text-2xl">{copy('Reminders')}</h2>
              {v.reminders.items.map((reminder) => (
                <Link
                  key={reminder.id}
                  to={`/app/clients/${reminder.client_id}/reminders/${reminder.id}`}
                  className="block border-b border-line py-4"
                >
                  <p className="break-words text-sm font-medium">
                    {reminder.title}
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {reminder.brand_name} · {time(reminder.scheduled_at)}
                  </p>
                </Link>
              ))}
            </section>
          ) : null}
        </div>
        <aside className="context-rail">
          <h2 className="eyebrow">{copy('My brands', 'operations')}</h2>
          {v.brands.items.map((b) => (
            <Link
              key={b.id}
              className="block border-b border-line py-4"
              to={`/app/clients/${b.id}`}
            >
              <p className="break-words">{b.name}</p>
              <p className="mt-1 text-xs text-muted">
                {copy('{{count}} websites', 'operations', {
                  count: b.websites,
                })}
              </p>
            </Link>
          ))}
          <Link
            className="mt-4 block text-xs underline underline-offset-4"
            to="/app/clients"
          >
            {copy('Open portfolio', 'operations')}
          </Link>
          {v.team_members !== undefined ? (
            <div className="mt-8 border-t border-line pt-5">
              <p className="eyebrow">
                {copy('Active team members', 'operations')}
              </p>
              <p className="mt-2 font-display text-3xl">{v.team_members}</p>
            </div>
          ) : null}
          {v.finance &&
          hasPermission(grants, {
            permission: 'finance.read_company',
            scope: 'global',
          }) ? (
            <section className="mt-8 border-t border-line pt-5">
              <h2 className="eyebrow">
                {copy('Outstanding receivables', 'operations')}
              </h2>
              {v.finance.length ? (
                v.finance.map((f) => (
                  <p
                    key={f.currency}
                    className="mt-3 break-words font-display text-2xl tabular-nums"
                  >
                    {money(f.outstanding_minor, f.currency)}
                    <span className="mt-2 block font-sans text-xs text-muted">
                      {copy('Overdue', 'operations')}:{' '}
                      {money(f.overdue_minor, f.currency)}
                    </span>
                  </p>
                ))
              ) : (
                <p className="mt-3 text-sm text-muted">
                  {copy('No outstanding payments', 'operations')}
                </p>
              )}
            </section>
          ) : null}
          {v.internal_finance?.length ? (
            <section className="mt-8 border-t border-line pt-5">
              <h2 className="eyebrow">
                {copy('Internal settlements', 'operations')}
              </h2>
              {v.internal_finance.map((f) => (
                <dl key={f.currency} className="mt-3 text-sm">
                  <dt className="text-muted">
                    {copy('Partner owes Roisey', 'operations')}
                  </dt>
                  <dd className="mt-1 tabular-nums">
                    {money(f.receivable_minor, f.currency)}
                  </dd>
                  <dt className="mt-2 text-muted">
                    {copy('Roisey owes partner', 'operations')}
                  </dt>
                  <dd className="mt-1 tabular-nums">
                    {money(f.payable_minor, f.currency)}
                  </dd>
                </dl>
              ))}
              <Link
                to="/app/finance"
                className="mt-4 block text-sm underline underline-offset-4"
              >
                {copy('Finance', 'operations')}
              </Link>
            </section>
          ) : null}
          <p className="mt-8 text-xs leading-6 text-muted">
            {copy('Updated {{value}}', 'operations', { value: time(v.as_of) })}
            <br />
            {v.timezone}
          </p>
        </aside>
      </div>
    </section>
  )
}
