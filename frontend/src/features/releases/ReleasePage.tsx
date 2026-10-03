import { Button } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { useReleaseReport } from './useReleaseReport'

export function ReleasePage() {
  const { allowed, query } = useReleaseReport()
  if (!allowed) return <AccessDenied />
  const runtime = !query.isError && !query.isFetching ? query.data?.runtime : undefined
  return <section className="max-w-5xl">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-6">
      <div><p className="eyebrow">System · Read only</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">Release Center</h1><p className="mt-2 max-w-xl text-sm text-muted">The current API build and the available release evidence.</p></div>
      <Button disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh release information</Button>
    </header>
    {query.isFetching ? <p role="status" aria-busy="true" className="mt-6 text-sm text-muted">Loading release information…</p> : query.isError ? <div className="mt-6 border border-line p-5"><p role="alert">Release information could not be loaded. Refresh to try again.</p></div> : runtime ? <>
      <section className="mt-6 border border-line p-5 sm:p-6" aria-labelledby="runtime-heading">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="runtime-heading" className="font-semibold">Running API build</h2><span className="rounded-sm border border-line px-2 py-1 text-xs">{runtime.status === 'available' ? 'Build identified' : 'Unavailable'}</span></div>
        {runtime.status === 'available' ? <dl className="mt-5 grid gap-5 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-sm text-muted">Version</dt><dd className="break-all font-mono text-sm">{runtime.version}</dd>
          <dt className="text-sm text-muted">Commit</dt><dd className="break-all font-mono text-sm">{runtime.commit_sha}</dd>
          <dt className="text-sm text-muted">Built at</dt><dd className="text-sm"><time dateTime={runtime.built_at}>{runtime.built_at.replace('T', ' ').replace('Z', ' UTC')}</time></dd>
        </dl> : <p className="mt-4 text-sm text-muted">This API binary has no valid embedded build metadata.</p>}
        <p className="mt-5 border-t border-line pt-4 text-xs text-muted">Build identity does not verify an image digest, an approved release or a successful deployment.</p>
      </section>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {[['Latest release', 'A verified release source is not connected.'], ['Image provenance', 'Verified image and artifact evidence is not connected.'], ['Deployment', 'A verified deployment source is not connected.']].map(([title, description]) => <section key={title} className="border border-line p-5"><h2 className="font-semibold">{title}</h2><p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Unavailable</p><p className="mt-3 text-sm text-muted">{description}</p></section>)}
      </div>
    </> : null}
  </section>
}
