import { formatCalendarDate } from '../../i18n/format'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  TextField,
  Table,
  buttonStyles,
  PageSkeleton,
} from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useBilling } from './hooks'
import { BillingHeader, BillingState, BillingError, Pager } from './Shared'
import { FinanceSummary } from './FinanceSummary'
import { defaultFilter, states, currencies, labels, pagePath } from './models'
import type { Filter } from './models'
import { money } from './money'
import * as api from './service'
export function BillingListPage() {
  useLocale()
  const { id = '' } = useParams()
  return <List key={id} clientID={id} />
}
function List({ clientID }: { clientID: string }) {
  useLocale()
  const operation = useBilling(clientID),
    [draft, setDraft] = useState<Filter>(defaultFilter),
    [filter, setFilter] = useState<Filter>(defaultFilter),
    [history, setHistory] = useState([''])
  const query = useQuery({
    queryKey: [...operation.key, 'list', filter, history.at(-1)],
    queryFn: ({ signal }) =>
      operation.read(() =>
        api.list(clientID, filter, history.at(-1) ?? '', signal),
      ),
    enabled: operation.permissions.view,
  })
  if (!operation.permissions.view) return <AccessDenied />
  return (
    <section>
      <BillingHeader title={copy('Finance', 'billing')} operation={operation}>
        <Button
          disabled={query.isFetching}
          onClick={() => {
            setHistory([''])
            void operation.cache.invalidateQueries({ queryKey: operation.key })
          }}
        >
          {copy('Refresh finance', 'billing')}
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(clientID) + '/new'}
          >
            {copy('Create collection', 'billing')}
          </Link>
        ) : null}
      </BillingHeader>
      <FinanceSummary operation={operation} />
      <form
        className="mb-5 grid gap-3 filter-bar sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault()
          setFilter({ ...draft, search: draft.search.trim() })
          setHistory([''])
        }}
      >
        <TextField
          label={copy('Search collections', 'billing')}
          maxLength={100}
          value={draft.search}
          onChange={(e) => setDraft({ ...draft, search: e.target.value })}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          {copy('State', 'billing')}{' '}
          <select
            className="ui-input"
            value={draft.status}
            onChange={(e) =>
              setDraft({ ...draft, status: e.target.value as Filter['status'] })
            }
          >
            <option value="all">{copy('All states', 'billing')}</option>
            {states.map((s) => (
              <option key={s} value={s}>
                {copy(labels[s], 'billing')}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          {copy('Currency filter', 'billing')}{' '}
          <select
            className="ui-input"
            value={draft.currency}
            onChange={(e) =>
              setDraft({
                ...draft,
                currency: e.target.value as Filter['currency'],
              })
            }
          >
            <option value="">
              {copy('All currencies, shown separately', 'billing')}
            </option>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <Button type="submit" className="self-end" disabled={query.isFetching}>
          {copy('Apply filters', 'billing')}
        </Button>
      </form>
      {query.isPending ? (
        <PageSkeleton label={copy('Loading collections…', 'billing')} />
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No collections on this page', 'billing')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Adjust the filters or create a collection if you have access.',
              'billing',
            )}
          </p>
        </div>
      ) : (
        <Table caption={copy('Client collections', 'billing')}>
          <thead>
            <tr>
              {[
                copy('Collection', 'billing'),
                copy('State', 'billing'),
                copy('Amount', 'billing'),
                copy('Collected', 'billing'),
                copy('Outstanding', 'billing'),
                copy('Due date', 'billing'),
                copy('Actions', 'billing'),
              ].map((v) => (
                <th
                  scope="col"
                  className={
                    [
                      copy('Amount', 'billing'),
                      copy('Collected', 'billing'),
                      copy('Outstanding', 'billing'),
                    ].includes(v)
                      ? 'text-right'
                      : ''
                  }
                  key={v}
                >
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
                    aria-label={copy('Open {{value1}}', 'billing', {
                      value1: r.description,
                    })}
                    to={pagePath(clientID, r.id)}
                  >
                    {r.description}
                  </Link>
                </td>
                <td>
                  <BillingState record={r} />
                </td>
                {(
                  ['amount_minor', 'paid_minor', 'outstanding_minor'] as const
                ).map((field) => (
                  <td
                    key={field}
                    className="whitespace-nowrap tabular-nums text-right text-[0.8125rem]"
                  >
                    {money(r[field], r.currency, r.currency_exponent)}
                  </td>
                ))}
                <td className="whitespace-nowrap text-xs">
                  {r.due_date
                    ? formatCalendarDate(r.due_date)
                    : copy('Not set', 'billing')}
                </td>
                <td>
                  <Link
                    className={buttonStyles({ size: 'compact' })}
                    to={pagePath(clientID, r.id)}
                  >
                    {copy('View collection', 'billing')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        name={copy('Collections', 'billing')}
        history={history}
        next={query.isError ? null : query.data?.page.next_cursor}
        busy={query.isFetching}
        onChange={setHistory}
      />
    </section>
  )
}
