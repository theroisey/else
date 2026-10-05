import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
  const { id = '' } = useParams()
  return <List key={id} clientID={id} />
}
function List({ clientID }: { clientID: string }) {
  useLocale()
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
      <PricingHeader
        title={copy('Pricing agreements', 'pricing')}
        operation={op}
      >
        <Button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {copy('Refresh pricing', 'pricing')}
        </Button>
        {op.permissions.manage && op.writable ? (
          <Link
            className={buttonStyles({ variant: 'primary' })}
            to={pagePath(clientID) + '/new'}
          >
            {copy('Create pricing agreement', 'pricing')}
          </Link>
        ) : null}
      </PricingHeader>
      {query.isPending ? (
        <PageSkeleton label={copy('Loading pricing agreements…', 'pricing')} />
      ) : query.isError ? (
        <PricingError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {!query.data.data.length ? (
            <div className="empty-state">
              <h2 className="font-semibold">
                {copy('No pricing agreements', 'pricing')}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {cursor
                  ? copy('No more agreements on this page.', 'pricing')
                  : copy(
                      'This client has no retained pricing agreements yet.',
                      'pricing',
                    )}
              </p>
            </div>
          ) : (
            <Table caption={copy('Pricing agreements', 'pricing')}>
              <thead>
                <tr>
                  <th scope="col">{copy('Agreement', 'pricing')}</th>
                  <th scope="col">{copy('Effective terms', 'pricing')}</th>
                  <th scope="col" className="text-right">
                    {copy('Agreed amount', 'pricing')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((s) => (
                  <tr key={s.id}>
                    <td className="min-w-48">
                      <Link
                        className="break-words font-medium underline underline-offset-4"
                        to={pagePath(clientID, s.id)}
                      >
                        {s.latest_version.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted">
                        {copy(
                          'Latest version {{value1}} · {{value2}}',
                          'pricing',
                          {
                            value1: s.revision,
                            value2: s.latest_version.currency,
                          },
                        )}
                      </p>
                    </td>
                    <td className="min-w-64">
                      <Window version={s.latest_version} />
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums font-medium">
                      {money(
                        s.latest_version.total_minor,
                        s.latest_version.currency,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pager
            name={copy('Pricing agreements', 'pricing')}
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
