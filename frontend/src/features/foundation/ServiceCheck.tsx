import { useQuery } from '@tanstack/react-query'
import { checkService } from './health-service'
import type { Service } from './health-service'

export function ServiceCheck({ service, label }: { service: Service; label: string }) {
  const query = useQuery({
    queryKey: ['service-status', service],
    queryFn: ({ signal }) => checkService(service, signal),
  })
  const checking = query.isPending || query.isFetching
  const status = checking ? 'Checking' : query.isError ? 'Check failed'
    : query.data === 'available' ? 'Available' : 'Not ready'
  const detail = checking ? 'Waiting for the service response.' : query.isError
    ? 'Service check failed. Try again.' : query.data === 'unavailable'
      ? 'Required services are not ready.' : 'Service is responding.'

  return (
    <div className="grid gap-2 border-b border-line py-5 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <dt className="font-medium">{label}</dt>
        <dd className="mt-1 text-muted">{detail}</dd>
      </div>
      <dd className="justify-self-start sm:justify-self-end">
        <span className="status">{status}</span>
      </dd>
    </div>
  )
}
