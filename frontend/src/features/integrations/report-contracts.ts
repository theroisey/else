import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { connectionSchema, revisionSchema } from './models'

const uuid = z.string().refine(isUUID)
export const reportTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/).refine(v => {
  const d = new Date(v)
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1 && d.toISOString().slice(0, 19) === v.slice(0, 19)
})
export const syncStatus = z.object({
  job_id: uuid.nullable(), state: z.enum(['not_synced', 'queued', 'running', 'succeeded', 'failed']),
  reason: z.enum(['provider_unavailable', 'authorization_required', 'connection_changed', 'interrupted']).nullable(),
  updated_at: reportTimestamp.nullable(), synced_at: reportTimestamp.nullable(), stale: z.boolean(),
}).strict().refine(v => (v.state === 'failed') === (v.reason !== null) &&
  (v.state === 'not_synced' ? v.job_id === null && v.updated_at === null : v.job_id !== null && v.updated_at !== null))

export function parseReportCatalog(body: unknown, client: string, provider: 'ga4' | 'woocommerce' | 'meta_ads', after = '') {
  const parsed = z.object({ data: z.array(connectionSchema).max(25), next_id: uuid.nullable() }).strict().safeParse(body)
  if (!parsed.success) throw new APIError(0, 'invalid_response')
  const { data, next_id } = parsed.data
  if (data.some((v, i) => v.client_id !== client || v.provider !== provider || v.id <= (i ? data[i - 1]!.id : after)) ||
    next_id !== null && (data.length !== 25 || next_id !== data.at(-1)?.id)) throw new APIError(0, 'invalid_response')
  return parsed.data
}
export function parseQueued(body: unknown, expectedRevision: bigint) {
  const parsed = z.object({ job_id: uuid, state: z.literal('queued'), connection_revision: revisionSchema }).strict().safeParse(body)
  if (!parsed.success || BigInt(parsed.data.connection_revision) !== expectedRevision) throw new APIError(0, 'invalid_response')
  return parsed.data
}
