import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table } from '../../components/ui'
import { Pager, PlanningError, PlanningTime } from './Shared'
import type { Operation } from './Shared'
import type { Filter } from './models'
import * as api from './service'

export function LinkHistory({ operation, recordID }: { operation: Operation; recordID: string }) {
  const [filter, setFilter] = useState<Filter['archived']>('all'),
    [history, setHistory] = useState([''])
  const cursor = history.at(-1) ?? ''
  const query = useQuery({
    queryKey: [...operation.key, 'task-links', operation.scope.planID, recordID, filter, cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.links(operation.scope, recordID, cursor, filter, signal)),
    enabled: operation.permissions.view,
  })
  return (
    <section className="mt-6 min-w-0 border-t border-line pt-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-semibold">Task link history</h3>
        <label className="grid gap-1.5 text-xs font-semibold">
          Reference history
          <select
            className="ui-input"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as Filter['archived'])
              setHistory([''])
            }}
          >
            <option value="all">All links</option>
            <option value="false">Current links</option>
            <option value="true">Removed links</option>
          </select>
        </label>
      </div>
      {query.isPending ? (
        <p role="status" className="mt-3" aria-busy="true">
          Loading link history…
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
          No link history on this page.
        </p>
      ) : (
        <div className="mt-4">
          <Table caption="Milestone task link history">
            <thead>
              <tr>
                {['Task reference', 'Linked', 'Removed'].map((s) => (
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
                      <span>Current link</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <Pager
        name="Task link history"
        history={history}
        next={!query.isError ? query.data?.page.next_cursor : null}
        busy={query.isFetching || operation.pending}
        onChange={setHistory}
      />
    </section>
  )
}
