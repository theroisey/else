import { copy, useLocale } from '../../i18n/index'
import { Button, PageSkeleton } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useReleaseReport } from './useReleaseReport'
import { EvidencePanel } from './EvidencePanel'

export function ReleasePage() {
  useLocale()
  const { allowed, query, refresh } = useReleaseReport()
  if (!allowed) return <AccessDenied />
  const runtime =
    !query.isError && !query.isFetching ? query.data?.runtime : undefined
  return (
    <section className="max-w-5xl">
      <header className="page-header">
        <div>
          <p className="eyebrow">{copy('System · Read only', 'releases')}</p>
          <h1 className="page-title">{copy('Release Center', 'releases')}</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            {copy(
              'The current API build and the available release evidence.',
              'releases',
            )}
          </p>
        </div>
        <Button disabled={query.isFetching} onClick={() => void refresh()}>
          {copy('Refresh release information', 'releases')}
        </Button>
      </header>
      {query.isFetching ? (
        <PageSkeleton
          label={copy('Loading release information…', 'releases')}
        />
      ) : query.isError ? (
        <div className="mt-6 border border-line p-5">
          <p role="alert">
            {copy(
              'Release information could not be loaded. Refresh to try again.',
              'releases',
            )}
          </p>
        </div>
      ) : runtime ? (
        <>
          <section
            className="mt-6 border border-line p-5 sm:p-6"
            aria-labelledby="runtime-heading"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="runtime-heading" className="font-semibold">
                {copy('Running API build', 'releases')}
              </h2>
              <span className="rounded-sm border border-line px-2 py-1 text-xs">
                {runtime.status === 'available'
                  ? copy('Build identified', 'releases')
                  : copy('Unavailable', 'releases')}
              </span>
            </div>
            {runtime.status === 'available' ? (
              <dl className="mt-5 grid gap-5 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-sm text-muted">
                  {copy('Version', 'releases')}
                </dt>
                <dd className="break-all font-mono text-sm">
                  {runtime.version}
                </dd>
                <dt className="text-sm text-muted">
                  {copy('Commit', 'releases')}
                </dt>
                <dd className="break-all font-mono text-sm">
                  {runtime.commit_sha}
                </dd>
                <dt className="text-sm text-muted">
                  {copy('Built at', 'releases')}
                </dt>
                <dd className="text-sm">
                  <time dateTime={runtime.built_at}>
                    {runtime.built_at
                      .replace('T', ' ')
                      .replace('Z', copy(' UTC', 'releases'))}
                  </time>
                </dd>
              </dl>
            ) : (
              <p className="mt-4 text-sm text-muted">
                {copy(
                  'This API binary has no valid embedded build metadata.',
                  'releases',
                )}
              </p>
            )}
            <p className="mt-5 border-t border-line pt-4 text-xs text-muted">
              {copy(
                'Build identity does not verify an image digest, an approved release or a successful deployment.',
                'releases',
              )}
            </p>
          </section>
          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {query.data ? (
              <>
                <EvidencePanel
                  title="Latest release"
                  observation={query.data.latest_release}
                />
                <EvidencePanel
                  title="Image provenance"
                  observation={query.data.image_provenance}
                  provenance
                />
                <EvidencePanel
                  title="Deployment"
                  observation={query.data.deployment}
                />
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
