import { expect, it, vi } from 'vitest'
import { parseReleaseReport, readReleaseReport } from './service'
import { report, stamp, unavailable, revision } from './fixtures.test-data'

it('accepts complete stamps and explicit independent unavailable observations', () => {
  expect(parseReleaseReport(report()).runtime).toEqual(stamp)
  expect(parseReleaseReport(report(unavailable)).runtime).toEqual(unavailable)
})

it('refuses malformed, partial, unknown and mismatched evidence without raw input', () => {
  for (const runtime of [
    { ...stamp, commit_sha: revision.toUpperCase() },
    { ...stamp, version: 'sha-' + 'b'.repeat(40) },
    { ...stamp, commit_sha: '0'.repeat(40), version: 'sha-' + '0'.repeat(40) },
    { ...stamp, built_at: '2026-02-30T18:00:00Z' },
    { ...stamp, built_at: '2026-10-03T18:00:00+00:00' },
    { ...stamp, built_at: '1999-01-01T00:00:00Z' },
    { ...stamp, version: '<script>synthetic-private-value</script>' },
    { ...stamp, extra: 'synthetic-private-value' },
    { ...unavailable, version: 'synthetic-private-value' },
  ])
    expect(() => parseReleaseReport(report(runtime))).toThrow(
      'Unable to complete this request.',
    )
  const bad = report()
  bad.data.latest_release.status = 'available'
  expect(() => parseReleaseReport(bad)).toThrow()
  expect(() =>
    parseReleaseReport({ ...report(), extra: 'synthetic-private-value' }),
  ).toThrow()
})

it('reads only the protected endpoint with same-origin no-store transport', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(report()), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  await readReleaseReport(new AbortController().signal)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/releases',
    expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: null,
    }),
  )
})

const artifact = {
  commit_sha: revision,
  tag: 'sha-' + revision,
  digest: 'sha256:' + 'c'.repeat(64),
  image_reference: 'ghcr.io/theroisey/else@sha256:' + 'c'.repeat(64),
  built_at: stamp.built_at,
  published_at: '2026-10-03T18:10:00Z',
  source: 'github_ghcr',
}
it('accepts bounded published artifacts, matched metadata and honest partial attestations', () => {
  const value = report()
  const richer = {
    data: {
      ...value.data,
      checked_at: '2026-10-03T18:20:00Z',
      latest_release: { status: 'available', artifact },
      image_provenance: {
        status: 'available',
        artifact,
        attestation: { status: 'present', reason: 'signature_not_verified' },
      },
    },
  }
  expect(parseReleaseReport(richer).image_provenance.status).toBe('available')
  expect(() =>
    parseReleaseReport({
      data: {
        ...richer.data,
        image_provenance: {
          status: 'available',
          artifact: {
            ...artifact,
            commit_sha: 'b'.repeat(40),
            tag: 'sha-' + 'b'.repeat(40),
          },
        },
      },
    }),
  ).toThrow()
  for (const change of [
    { digest: 'sha256:' + 'd'.repeat(64) },
    { image_reference: 'https://private.example/image' },
    { tag: 'latest' },
    { published_at: '2026-02-30T00:00:00Z' },
    { source: 'caller-selected-source' },
  ])
    expect(() =>
      parseReleaseReport({
        data: {
          ...richer.data,
          latest_release: {
            status: 'available',
            artifact: { ...artifact, ...change },
          },
        },
      }),
    ).toThrow()
  expect(() =>
    parseReleaseReport({
      data: {
        ...richer.data,
        image_provenance: {
          status: 'available',
          artifact,
          attestation: { status: 'verified', reason: 'signature_not_verified' },
        },
      },
    }),
  ).toThrow()
})
it('manual refresh revalidates through a fixed header without source parameters', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(report()), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  await readReleaseReport(new AbortController().signal, true)
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/releases',
    expect.objectContaining({
      headers: {
        Accept: 'application/json',
        'X-Release-Refresh': 'revalidate',
      },
    }),
  )
})
