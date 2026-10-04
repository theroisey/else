import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { connectionSchema, parseConnection, revisionSchema } from '../integrations/models'
import type { Connection } from '../integrations/models'
import { parseCatalog, parseQueued, parseView, validPeriod } from './models'
import type { Period } from './models'

function path(client: string, connection?: string) {
  if (!isUUID(client) || connection !== undefined && !isUUID(connection)) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/commerce${connection ? '/' + connection : ''}`
}
export async function list(client: string, after: string, signal: AbortSignal) {
  if (after && !isUUID(after)) throw new APIError(0, 'invalid_request')
  return parseCatalog(await authenticatedJSON(path(client) + (after ? '?after=' + after : ''), { signal }), client, after)
}
export async function read(client: string, connection: string, period: Period, signal: AbortSignal) {
  if (!validPeriod(period)) throw new APIError(0, 'invalid_request')
  return parseView(await authenticatedJSON(path(client, connection) + '?' + new URLSearchParams({ ...period }), { signal }), client, connection, period)
}
export function validOrigin(value: string) {
  if (value.length > 520) return false
  try {
    const url = new URL(value), labels = url.hostname.split('.')
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      value === `https://${url.hostname}${url.pathname === '/' ? '' : url.pathname}` && url.hostname.length <= 253 &&
      labels.length > 1 && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(labels.at(-1)!) &&
      labels.every(label => label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) &&
      url.pathname.length <= 256 && (url.pathname === '/' || /^(\/[A-Za-z0-9_-]+)*$/.test(url.pathname))
  } catch { return false }
}
export async function create(client: string, origin: string) {
  path(client)
  if (!validOrigin(origin)) throw new APIError(0, 'invalid_request')
  const body = await authenticatedJSON(`/api/v1/clients/${client}/integrations/woocommerce`, { method: 'POST', body: { origin } })
  const id = connectionSchema.safeParse((body as { data?: unknown } | null)?.data)
  if (!id.success) throw new APIError(0, 'invalid_response')
  const record = parseConnection(body, client, id.data.id)
  if (record.provider !== 'woocommerce' || record.state !== 'pending' || record.revision !== '1') throw new APIError(0, 'invalid_response')
  return record
}
export async function queue(record: Connection, period: Period, credential?: { consumer_key: string; consumer_secret: string }) {
  path(record.client_id, record.id)
  if (!validPeriod(period) || record.provider !== 'woocommerce' || !['pending', 'connected', 'reauthorization_required'].includes(record.state) ||
    !revisionSchema.safeParse(record.revision).success || BigInt(record.revision) > (credential ? 9223372036854775805n : 9223372036854775806n) ||
    credential && (!/^ck_[0-9a-f]{40}$/.test(credential.consumer_key) || !/^cs_[0-9a-f]{40}$/.test(credential.consumer_secret) ||
      /^ck_0+$/.test(credential.consumer_key) || /^cs_0+$/.test(credential.consumer_secret))) throw new APIError(0, 'invalid_request')
  return parseQueued(await authenticatedJSON(`/api/v1/clients/${record.client_id}/integrations/${record.id}/woocommerce/${credential ? 'credentials' : 'sync'}`, {
    method: 'POST', body: { revision: record.revision, ...period, ...credential },
  }), BigInt(record.revision) + (credential ? 2n : 0n))
}
