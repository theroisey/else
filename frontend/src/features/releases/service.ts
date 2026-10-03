import { z } from 'zod'
import { APIError, authenticatedJSON } from '../../services/authenticated'

const revision = z.string().regex(/^[0-9a-f]{40}$/).refine(v => v !== '0'.repeat(40))
const builtAt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(v => {
  const date = new Date(v)
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.toISOString() === v.slice(0, 19) + '.000Z'
})
const runtime = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), version: z.string().max(44), commit_sha: revision, built_at: builtAt }).strict(),
  z.object({ status: z.literal('unavailable'), version: z.null(), commit_sha: z.null(), built_at: z.null() }).strict(),
]).refine(v => v.status === 'unavailable' || v.version === 'sha-' + v.commit_sha)
const unavailable = z.object({ status: z.literal('unavailable') }).strict()
const report = z.object({ data: z.object({ runtime, latest_release: unavailable, image_provenance: unavailable, deployment: unavailable }).strict() }).strict()
export type ReleaseReport = z.infer<typeof report>['data']

export function parseReleaseReport(value: unknown): ReleaseReport {
  const result = report.safeParse(value)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data.data
}

export async function readReleaseReport(signal: AbortSignal) {
  return parseReleaseReport(await authenticatedJSON('/api/v1/releases', { signal }))
}
