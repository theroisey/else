import { useQuery } from '@tanstack/react-query'
import { z } from '../../lib/validation'
import { authenticatedJSON } from '../../services/authenticated'
import { data, exact } from '../operations/models'
import { useRecordOperations } from '../auth/useRecordOperations'
import { copy, useLocale } from '../../i18n'
import { Button } from '../../components/ui'
import { OperationsError } from '../operations/Shared'
const counts = z
  .object({
    requests: exact,
    failures: exact,
    active: exact,
    duration_microseconds: exact,
    duration_buckets: z.array(exact).length(10),
  })
  .strict()
const metrics = z
  .object({
    http: counts,
    tools: z
      .array(z.object({ name: z.string().max(128), counts }).strict())
      .max(256),
    bucket_upper_microseconds: z.array(z.number().int().positive()).length(9),
    concurrency_limit: z.literal(12),
    response_limit_bytes: z.literal(524288),
  })
  .strict()
export function MCPActivity() {
  useLocale()
  const op = useRecordOperations('mcp')
  const q = useQuery({
    queryKey: [...op.key, 'metrics'],
    queryFn: ({ signal }) =>
      op.read(async () =>
        data(
          metrics,
          await authenticatedJSON('/api/v1/mcp/metrics', { signal }),
        ),
      ),
    staleTime: 30_000,
  })
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h3 className="font-semibold">{copy('Connection activity', 'mcp')}</h3>
      <p className="text-xs text-muted">
        {copy(
          'Current process only. Arguments, tokens and personal activity text are excluded.',
          'mcp',
        )}
      </p>
      {q.isError ? (
        <OperationsError
          error={q.error}
          retry={() => {
            void q.refetch()
          }}
        />
      ) : q.data ? (
        <dl className="grid grid-cols-3 gap-3">
          {(['requests', 'failures', 'active'] as const).map((key) => (
            <div key={key}>
              <dt className="text-xs text-muted">
                {copy(
                  {
                    requests: 'Requests',
                    failures: 'Failures',
                    active: 'In-flight',
                  }[key],
                  'mcp',
                )}
              </dt>
              <dd className="mt-1 text-xl tabular-nums">{q.data.http[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Button
        variant="ghost"
        disabled={q.isFetching}
        onClick={() => {
          void q.refetch()
        }}
      >
        {copy('Refresh activity', 'mcp')}
      </Button>
    </section>
  )
}
