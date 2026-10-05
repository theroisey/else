import { copy } from '../../i18n'
import type { ReleaseReport } from './service'

const reasons: Record<string, string> = {
  not_configured:
    'Configure server-only GitHub credentials to connect release evidence.',
  invalid_configuration:
    'Check the server GitHub repository and credential configuration.',
  authentication_failed:
    'The GitHub credential is invalid or expired. Update the server credential.',
  access_denied:
    'The credential cannot read this evidence. Check repository and package read permissions.',
  rate_limited:
    'The evidence source is rate limited. Revalidation will resume after the backoff.',
  not_found: 'No matching published artifact or evidence was found.',
  timeout: 'The evidence source timed out. Refresh to try again.',
  source_unreachable:
    'The evidence source could not be reached. Refresh to try again.',
  invalid_evidence: 'The source returned incomplete or invalid evidence.',
  digest_mismatch: 'The image content does not match its expected digest.',
  revision_mismatch:
    'The published image revision does not match the expected commit.',
  repository_mismatch:
    'The evidence does not belong to the configured repository.',
  metadata_incomplete:
    'The image lacks the required OCI source, revision or version metadata.',
  runtime_unidentified:
    'Identify the running API build before comparing its published image.',
  runtime_metadata_mismatch:
    'The registry image build metadata does not match this API binary.',
  package_token_unsupported:
    'Private GHCR packages require a classic PAT with read:packages. A fine-grained PAT cannot authenticate to this package.',
  deployment_source_not_connected:
    'No production deployment evidence source is connected. Artifact publication does not prove a rollout.',
  signature_not_verified:
    'A digest-matching attestation is present. Its signature has not been verified by this application.',
}

export function EvidencePanel({
  title,
  observation,
  provenance = false,
}: {
  title: string
  observation: ReleaseReport['latest_release']
  provenance?: boolean
}) {
  return (
    <section className="min-w-0 border border-line p-5">
      <h2 className="font-semibold">{copy(title, 'releases')}</h2>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">
        {copy(
          observation.status === 'available'
            ? provenance
              ? 'Image metadata matched'
              : 'Published artifact identified'
            : 'Unavailable',
          'releases',
        )}
      </p>
      {observation.status === 'available' ? (
        <>
          <dl className="mt-4 grid gap-2 text-xs">
            <dt className="text-muted">{copy('Immutable tag', 'releases')}</dt>
            <dd translate="no" className="break-all font-mono">
              {observation.artifact.tag}
            </dd>
            <dt className="mt-2 text-muted">
              {copy('Image digest', 'releases')}
            </dt>
            <dd translate="no" className="break-all font-mono">
              {observation.artifact.digest}
            </dd>
            <dt className="mt-2 text-muted">
              {copy('Image reference', 'releases')}
            </dt>
            <dd translate="no" className="break-all font-mono">
              {observation.artifact.image_reference}
            </dd>
            <dt className="mt-2 text-muted">
              {copy('Published at', 'releases')}
            </dt>
            <dd>
              {observation.artifact.published_at ? (
                <time dateTime={observation.artifact.published_at}>
                  {observation.artifact.published_at
                    .replace('T', ' ')
                    .replace('Z', copy(' UTC', 'releases'))}
                </time>
              ) : (
                copy('Publication time is not available.', 'releases')
              )}
            </dd>
            <dt className="mt-2 text-muted">{copy('Source', 'releases')}</dt>
            <dd translate="no">GitHub / GHCR</dd>
          </dl>
          {provenance ? (
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {copy(
                'Registry content and OCI metadata match the API build. This does not prove the host is running that container digest.',
                'releases',
              )}
            </p>
          ) : null}
          {observation.attestation ? (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="text-xs font-semibold">
                {copy('Signed attestation', 'releases')}
              </h3>
              <p className="mt-2 text-xs text-muted">
                {copy(reasons[observation.attestation.reason], 'releases')}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-sm text-muted">
          {copy(
            reasons[
              observation.reason ??
                (title === 'Deployment'
                  ? 'deployment_source_not_connected'
                  : 'not_configured')
            ],
            'releases',
          )}
        </p>
      )}
    </section>
  )
}
