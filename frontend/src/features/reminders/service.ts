import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { parsePage, parseRecord, parseOwners, parseMutation, profileSchema } from './models'
import type { Filter, Profile } from './models'
function path(client: string, id?: string) {
  if (!isUUID(client) || (id !== undefined && !isUUID(id))) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/reminders${id ? '/' + id : ''}`
}
function paging(cursor: string) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return q
}
export async function list(client: string, f: Filter, cursor: string, signal: AbortSignal) {
  if (
    !['pending', 'completed', 'dismissed', 'all'].includes(f.status) ||
    !['all', 'due', 'upcoming'].includes(f.due) ||
    !['id', '-id'].includes(f.sort) ||
    (!['any', 'me'].includes(f.owner) && !isUUID(f.owner)) ||
    [...f.q.trim()].length > 100 ||
    /[\p{Cc}]/u.test(f.q)
  )
    throw new APIError(0, 'invalid_request')
  const q = paging(cursor)
  q.set('status', f.status)
  q.set('due', f.due)
  q.set('owner', f.owner)
  q.set('sort', f.sort)
  if (f.q.trim()) q.set('q', f.q.trim())
  const p = parsePage(await authenticatedJSON(`${path(client)}?${q}`, { signal }))
  if (p.data.some((r) => r.client_id !== client.toLowerCase()))
    throw new APIError(0, 'invalid_response')
  return p
}
export async function detail(client: string, id: string, signal?: AbortSignal) {
  const r = parseRecord(await authenticatedJSON(path(client, id), signal ? { signal } : {}))
  if (r.client_id !== client.toLowerCase() || r.id !== id.toLowerCase())
    throw new APIError(0, 'invalid_response')
  return r
}
export async function owners(client: string, cursor: string, signal: AbortSignal) {
  return parseOwners(
    await authenticatedJSON(`${path(client)}/owners?${paging(cursor)}`, { signal }),
  )
}
function expected(v: number) {
  if (!Number.isSafeInteger(v) || v < 1 || v >= Number.MAX_SAFE_INTEGER)
    throw new APIError(0, 'invalid_request')
}
function confirmed(body: unknown, revision: number, id?: string) {
  const r = parseMutation(body)
  if (r.revision !== revision || (id && r.id !== id.toLowerCase()))
    throw new APIError(0, 'invalid_response')
  return r
}
export async function create(client: string, p: Profile) {
  return confirmed(
    await authenticatedJSON(path(client), { method: 'POST', body: profileSchema.parse(p) }),
    1,
  )
}
export async function update(client: string, id: string, p: Profile, revision: number) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(client, id), {
      method: 'PUT',
      body: { ...profileSchema.parse(p), expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function finish(
  client: string,
  id: string,
  action: 'complete' | 'dismiss',
  revision: number,
) {
  expected(revision)
  if (action !== 'complete' && action !== 'dismiss') throw new APIError(0, 'invalid_request')
  return confirmed(
    await authenticatedJSON(path(client, id) + '/' + action, {
      method: 'POST',
      body: { expected_revision: revision, ...(action === 'dismiss' ? { confirm: true } : {}) },
    }),
    revision + 1,
    id,
  )
}
