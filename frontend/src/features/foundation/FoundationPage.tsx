import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { ServiceCheck } from './ServiceCheck'

export function FoundationPage() {
  const client = useQueryClient()
  const checking = useIsFetching({ queryKey: ['service-status'] }) > 0

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <span className="font-semibold tracking-tight">ROISEY ELSE</span>
          <span className="eyebrow text-right">Development foundation</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-14">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Service status</h1>
            <p className="mt-2 max-w-xl text-muted">Current availability of the backend and its required services.</p>
          </div>
          <button className="control inline-flex" type="button" disabled={checking}
            onClick={() => { void client.invalidateQueries({ queryKey: ['service-status'] }) }}>
            <FontAwesomeIcon icon={faArrowRotateRight} aria-hidden="true" />
            {checking ? 'Checking services' : 'Check again'}
          </button>
        </div>
        <section aria-label="Service checks" aria-live="polite" aria-busy={checking}
          className="mt-8 rounded-md border border-line bg-surface px-5">
          <dl>
            <ServiceCheck service="backend" label="Backend" />
            <ServiceCheck service="readiness" label="Readiness" />
          </dl>
        </section>
        <p className="mt-5 text-xs text-muted">Client operations are not available yet. These checks contain no client data.</p>
      </main>
    </div>
  )
}
