import type { Session } from '../auth/session'

export const revision = 'a'.repeat(40)
export const stamp = { status: 'available', version: 'sha-' + revision, commit_sha: revision, built_at: '2026-10-03T18:00:00Z' }
export const unavailable = { status: 'unavailable', version: null, commit_sha: null, built_at: null }
export const report = (runtime: unknown = stamp) => ({ data: { runtime, latest_release: { status: 'unavailable' }, image_provenance: { status: 'unavailable' }, deployment: { status: 'unavailable' } } })
export const identity: Session = {
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'release.fixture@example.com', display_name: 'Synthetic Release Reader', permissions: [{ permission: 'releases.view', scope: 'global' }] },
  session: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
}
