import { copy, useLocale } from '../../i18n/index'
import { Brand } from '../../components/brand/Brand'
import { AppearanceControl } from '../appearance/Appearance'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Link } from 'react-router'
import { Button, buttonStyles } from '../../components/ui'
import { ServiceCheck } from './ServiceCheck'

export function FoundationPage() {
  useLocale()
  const client = useQueryClient()
  const checking = useIsFetching({ queryKey: ['service-status'] }) > 0

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <Brand />
          <div className="flex flex-wrap gap-2">
            <Link
              className={buttonStyles({ variant: 'ghost', size: 'compact' })}
              to="/interface"
            >
              {copy('Interface review', 'common')}
            </Link>
            <Link
              className={buttonStyles({ variant: 'ghost', size: 'compact' })}
              to="/app"
            >
              {copy('Workspace', 'common')}
            </Link>
            <AppearanceControl />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-14">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">{copy('Service status', 'common')}</h1>
            <p className="mt-2 max-w-xl text-muted">
              {copy(
                'Current availability of the backend and its required services.',
                'common',
              )}
            </p>
          </div>
          <Button
            icon={faArrowRotateRight}
            loading={checking}
            loadingLabel={copy('Checking services', 'common')}
            onClick={() => {
              void client.invalidateQueries({ queryKey: ['service-status'] })
            }}
          >
            {copy('Check again', 'common')}
          </Button>
        </div>
        <section
          aria-label={copy('Service checks', 'common')}
          aria-live="polite"
          aria-busy={checking}
          className="mt-8 rounded-md border border-line bg-surface px-5"
        >
          <dl>
            <ServiceCheck service="backend" label={copy('Backend', 'common')} />
            <ServiceCheck
              service="readiness"
              label={copy('Readiness', 'common')}
            />
          </dl>
        </section>
        <p className="mt-5 text-xs text-muted">
          {copy(
            'These public availability checks contain no client data. Sign in to open client operations.',
            'common',
          )}
        </p>
      </main>
    </div>
  )
}
