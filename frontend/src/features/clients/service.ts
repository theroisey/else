import { authenticatedJSON, APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { parseClient, parsePage, parseMutation } from './models'
import type { Filter, Profile } from './models'

function path(id: string) {
  if (!isUUID(id)) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${id}`
}
export async function clients(filter: Filter, cursor: string, signal: AbortSignal) {
  if (
    (cursor && !isUUID(cursor)) ||
    !['active', 'archived', 'all'].includes(filter.status) ||
    !['id', '-id'].includes(filter.sort) ||
    [...filter.q.trim()].length > 100 ||
    [...filter.tag.trim()].length > 40 ||
    /[\p{Cc}]/u.test(filter.q + filter.tag)
  )
    throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({
    limit: '25',
    status: filter.status,
    sort: filter.sort,
  })
  if (filter.q.trim()) query.set('q', filter.q.trim())
  if (filter.tag.trim()) query.set('tag', filter.tag.trim().toLowerCase())
  if (cursor) query.set('cursor', cursor)
  return authenticatedJSON(`/api/v1/clients?${query}`, { signal }).then(parsePage)
}
export const client = async (id: string, signal?: AbortSignal) =>
  authenticatedJSON(path(id), signal ? { signal } : {}).then(parseClient)
function confirmed(body: unknown, expected: number, id?: string) {
  const result = parseMutation(body)
  if (result.revision !== expected || (id && result.id !== id))
    throw new APIError(0, 'invalid_response')
  return result
}
export const create = (profile: Profile) =>
  authenticatedJSON('/api/v1/clients', { method: 'POST', body: profile }).then((body) =>
    confirmed(body, 1),
  )
export const update = async (id: string, profile: Profile, expected_revision: number) =>
  authenticatedJSON(path(id), {
    method: 'PUT',
    body: { ...profile, expected_revision },
  }).then((body) => confirmed(body, expected_revision + 1, id))
export const archive = async (id: string, expected_revision: number) =>
  authenticatedJSON(`${path(id)}/archive`, {
    method: 'POST',
    body: { expected_revision, confirm: true },
  }).then((body) => confirmed(body, expected_revision + 1, id))
