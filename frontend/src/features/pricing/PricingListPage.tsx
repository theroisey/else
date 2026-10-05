import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Table, buttonStyles, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { usePricing } from './hooks'
import { PricingHeader, PricingError, Pager, Window } from './Shared'
import { pagePath } from './models'
import { money } from '../billing/money'
import * as api from './service'
export function PricingListPage() {
  const { id = '' } = useParams()
  return <List key={id} clientID={id} />
}
function List({ clientID }: { clientID: string }) {
  const op = usePricing(clientID),
    [history, setHistory] = useState(['']),
    cursor = history.at(-1)!
  const query = useQuery({
    queryKey: [...op.key, 'list', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.list(clientID, op.permissions.manage, cursor, signal)),
    enabled: op.permissions.view,
  })
  if (!op.permissions.view) return <AccessDenied />
  return (
    <section>
      <PricingHeader title="Pricing agreements" operation={op}>
        <Button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh pricing
        </Button>
        {op.permissions.manage && op.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(clientID) + '/new'}
          >
            Create pricing agreement
          </Link>
        ) : null}
      </PricingHeader>
      {query.isPending ? (
        <PageSkeleton label="Loading pricing agreements…" />
      ) : query.isError ? (
        <PricingError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {!query.data.data.length ? (
            <div className="empty-state">
              <h2 className="font-semibold">No pricing agreements</h2>
              <p className="mt-2 text-sm text-muted">
                {cursor
                  ? 'No more agreements on this page.'
                  : 'This client has no retained pricing agreements yet.'}
              </p>
            </div>
          ) : (
            <Table caption="Pricing agreements"><thead><tr><th scope="col">Agreement</th><th scope="col">Effective terms</th><th scope="col" className="text-right">Agreed amount</th></tr></thead><tbody>{query.data.data.map(s => <tr key={s.id}><td className="min-w-48"><Link className="break-words font-medium underline underline-offset-4" to={pagePath(clientID, s.id)}>{s.latest_version.title}</Link><p className="mt-1 text-xs text-muted">Latest version {s.revision} · {s.latest_version.currency}</p></td><td className="min-w-64"><Window version={s.latest_version} /></td><td className="whitespace-nowrap text-right tabular-nums font-medium">{money(s.latest_version.total_minor, s.latest_version.currency)}</td></tr>)}</tbody></Table>

          )}
          <Pager
            name="Pricing agreements"
            history={history}
            next={query.data.page.next_cursor}
            busy={query.isFetching}
            onChange={setHistory}
          />
        </>
      )}
    </section>
  )
}
