import { copy, useLocale } from '../../i18n/index'
import { useQuery } from '@tanstack/react-query'
import { Status } from '../../components/ui'
import { checkService } from './health-service'
import type { Service } from './health-service'

export function ServiceCheck({
  service,
  label,
}: {
  service: Service
  label: string
}) {
  useLocale()
  const query = useQuery({
    queryKey: ['service-status', service],
    queryFn: ({ signal }) => checkService(service, signal),
  })
  const checking = query.isPending || query.isFetching
  const status = checking
    ? copy('Checking', 'common')
    : query.isError
      ? copy('Check failed', 'common')
      : query.data === 'available'
        ? copy('Available', 'common')
        : copy('Not ready', 'common')
  const detail = checking
    ? copy('Waiting for the service response.', 'common')
    : query.isError
      ? copy('Service check failed. Try again.', 'common')
      : query.data === 'unavailable'
        ? copy('Required services are not ready.', 'common')
        : copy('Service is responding.', 'common')
  const tone = checking
    ? 'neutral'
    : query.isError
      ? 'danger'
      : query.data === 'available'
        ? 'success'
        : 'warning'

  return (
    <div className="grid gap-2 border-b border-line py-5 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <dt className="font-medium">{label}</dt>
        <dd className="mt-1 text-muted">{detail}</dd>
      </div>
      <dd className="justify-self-start sm:justify-self-end">
        <Status tone={tone}>{status}</Status>
      </dd>
    </div>
  )
}
