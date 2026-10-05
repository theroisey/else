import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, TextField, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useBilling } from './hooks'
import { BillingHeader, BillingState, BillingError, Pager } from './Shared'
import { FinanceSummary } from './FinanceSummary'
import { defaultFilter, states, currencies, labels, pagePath } from './models'
import type { Filter } from './models'
import { money } from './money'
import * as api from './service'
export function BillingListPage() {
  const { id = '' } = useParams()
  return <List key={id} clientID={id} />
}
function List({ clientID }: { clientID: string }) {
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
      <BillingHeader title="Finance" operation={operation}>
        <Button
          disabled={query.isFetching}
          onClick={() => {
            setHistory([''])
            void operation.cache.invalidateQueries({ queryKey: operation.key })
          }}
        >
          Refresh finance
        </Button>
        {operation.permissions.create && operation.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(clientID) + '/new'}
          >
            Create collection
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
          label="Search collections"
          maxLength={100}
          value={draft.search}
          onChange={(e) => setDraft({ ...draft, search: e.target.value })}
        />
        <label className="grid gap-1.5 text-sm font-semibold">
          State
          <select
            className="ui-input"
            value={draft.status}
            onChange={(e) =>
              setDraft({ ...draft, status: e.target.value as Filter['status'] })
            }
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
          Currency filter
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
            <option value="">All currencies, shown separately</option>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <Button type="submit" className="self-end" disabled={query.isFetching}>
          Apply filters
        </Button>
      </form>
      {query.isPending ? (
        <PageSkeleton label="Loading collections…" />
      ) : query.isError ? (
        <BillingError error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.data.length ? (
        <div className="empty-state">
          <h2 className="font-semibold">No collections on this page</h2>
          <p className="mt-2 text-muted">
            Adjust the filters or create a collection if you have access.
          </p>
        </div>
      ) : (
        <Table caption="Client collections">
          <thead>
            <tr>
              {[
                'Collection',
                'State',
                'Amount',
                'Collected',
                'Outstanding',
                'Due date',
                'Actions',
              ].map((v) => (
                <th scope="col" className={['Amount', 'Collected', 'Outstanding'].includes(v) ? 'text-right' : ''} key={v}>
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
                    aria-label={`Open ${r.description}`}
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
                  {r.due_date ?? 'Not set'}
                </td>
                <td>
                  <Link
                    className={buttonStyles({ size: 'compact' })}
                    to={pagePath(clientID, r.id)}
                  >
                    View collection
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        name="Collections"
        history={history}
        next={query.isError ? null : query.data?.page.next_cursor}
        busy={query.isFetching}
        onChange={setHistory}
      />
    </section>
  )
}
