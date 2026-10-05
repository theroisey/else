import { SelectField } from '../../components/ui'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table } from '../../components/ui'
import { Pager, PlanningError, PlanningTime } from './Shared'
import type { Operation } from './Shared'
import type { Filter } from './models'
import * as api from './service'

export function LinkHistory({
  operation,
  recordID,
}: {
  operation: Operation
  recordID: string
}) {
  useLocale()
  const [filter, setFilter] = useState<Filter['archived']>('all'),
    [history, setHistory] = useState([''])
  const cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [
      ...operation.key,
      'task-links',
      operation.scope.planID,
      recordID,
      filter,
      cursor,
    ],
    queryFn: ({ signal }) =>
      operation.read(() =>
        api.links(operation.scope, recordID, cursor, filter, signal),
      ),
    enabled: operation.permissions.view,
  })
  return (
    <section className="mt-6 min-w-0 border-t border-line pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-semibold">
          {copy('Task link history', 'planning')}
        </h3>
        <SelectField
          label={copy('Reference history', 'planning')}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as Filter['archived'])
            setHistory([''])
          }}
        >
          <option value="all">{copy('All links', 'planning')}</option>
          <option value="false">{copy('Current links', 'planning')}</option>
          <option value="true">{copy('Removed links', 'planning')}</option>
        </SelectField>
      </div>
      {query.isPending ? (
        <p role="status" className="mt-3" aria-busy="true">
          {copy('Loading link history…', 'planning')}
        </p>
      ) : query.isError ? (
        <PlanningError
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : !query.data.data.length ? (
        <p role="status" className="mt-3">
          {copy('No link history on this page.', 'planning')}
        </p>
      ) : (
        <div className="mt-4">
          <Table caption={copy('Milestone task link history', 'planning')}>
            <thead>
              <tr>
                {[
                  copy('Task reference', 'planning'),
                  copy('Linked', 'planning'),
                  copy('Removed', 'planning'),
                ].map((s) => (
                  <th key={s} scope="col">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.data.map((l) => (
                <tr key={l.id}>
                  <td className="max-w-72 break-all text-xs">{l.task_id}</td>
                  <td className="min-w-40 text-xs">
                    <PlanningTime value={l.linked_at} />
                  </td>
                  <td className="min-w-40 text-xs">
                    {l.unlinked_at ? (
                      <PlanningTime value={l.unlinked_at} />
                    ) : (
                      <span>{copy('Current link', 'planning')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <Pager
        name={copy('Task link history', 'planning')}
        history={history}
        next={!query.isError ? query.data?.page.next_cursor : null}
        busy={query.isFetching || operation.pending}
        onChange={setHistory}
      />
    </section>
  )
}
