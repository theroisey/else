import { expect, it, vi } from 'vitest'
import { parseReleaseReport, readReleaseReport } from './service'
import { report, stamp, unavailable, revision } from './fixtures.test-data'

it('accepts complete stamps and explicit independent unavailable observations', () => {
  expect(parseReleaseReport(report()).runtime).toEqual(stamp)
  expect(parseReleaseReport(report(unavailable)).runtime).toEqual(unavailable)
})

it('refuses malformed, partial, unknown and mismatched evidence without raw input', () => {
  for (const runtime of [
    { ...stamp, commit_sha: revision.toUpperCase() }, { ...stamp, version: 'sha-' + 'b'.repeat(40) },
    { ...stamp, commit_sha: '0'.repeat(40), version: 'sha-' + '0'.repeat(40) },
    { ...stamp, built_at: '2026-02-30T18:00:00Z' }, { ...stamp, built_at: '2026-10-03T18:00:00+00:00' },
    { ...stamp, built_at: '1999-01-01T00:00:00Z' }, { ...stamp, version: '<script>synthetic-private-value</script>' },
    { ...stamp, extra: 'synthetic-private-value' }, { ...unavailable, version: 'synthetic-private-value' },
  ]) expect(() => parseReleaseReport(report(runtime))).toThrow('Unable to complete this request.')
  const bad = report()
  bad.data.latest_release.status = 'available'
  expect(() => parseReleaseReport(bad)).toThrow()
  expect(() => parseReleaseReport({ ...report(), extra: 'synthetic-private-value' })).toThrow()
})

it('reads only the protected endpoint with same-origin no-store transport', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(report()), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  await readReleaseReport(new AbortController().signal)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledWith('/api/v1/releases', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: null }))
})
