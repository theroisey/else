import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  metadataSchema,
  linkSetSchema,
  parseRecord,
  parsePage,
  parseCandidates,
  parseLinks,
  parseMutation,
  planStates,
  milestoneStates,
} from './models'
import type { Scope, Metadata, Filter, State, Summary } from './models'
function path(scope: Scope, id?: string) {
  if (
    !isUUID(scope.clientID) ||
    (scope.planID !== undefined && !isUUID(scope.planID)) ||
    (id !== undefined && !isUUID(id))
  )
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${scope.clientID}/plans${scope.planID ? '/' + scope.planID + '/milestones' : ''}${id ? '/' + id : ''}`
}
function paging(cursor: string) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return q
}
function scoped(scope: Scope, r: Summary) {
  return (
    r.client_id === scope.clientID.toLowerCase() &&
    r.plan_id === scope.planID?.toLowerCase()
  )
}
export async function list(
  scope: Scope,
  f: Filter,
  cursor: string,
  signal: AbortSignal,
) {
  if (
    !['all', ...(scope.planID ? milestoneStates : planStates)].includes(
      f.status,
    ) ||
    !['false', 'true', 'all'].includes(f.archived) ||
    !['id', '-id'].includes(f.sort) ||
    [...f.q.trim()].length > 100 ||
    /[\p{Cc}]/u.test(f.q)
  )
    throw new APIError(0, 'invalid_request')
  const q = paging(cursor)
  q.set('status', f.status)
  q.set('archived', f.archived)
  q.set('sort', f.sort)
  if (f.q.trim()) q.set('q', f.q.trim())
  const p = parsePage(
    await authenticatedJSON(`${path(scope)}?${q}`, { signal }),
  )
  if (p.page.limit !== 25 || p.data.some((r) => !scoped(scope, r)))
    throw new APIError(0, 'invalid_response')
  return p
}
export async function detail(scope: Scope, id: string, signal?: AbortSignal) {
  const r = parseRecord(
    await authenticatedJSON(path(scope, id), signal ? { signal } : {}),
  )
  if (!scoped(scope, r) || r.id !== id.toLowerCase())
    throw new APIError(0, 'invalid_response')
  return r
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
function metadata(scope: Scope, p: Metadata) {
  const m = metadataSchema.parse(p)
  if (!scope.planID) return m
  if (m.start_at !== null) throw new APIError(0, 'invalid_request')
  const { title, description, due_at } = m
  return { title, description, due_at }
}
export async function create(scope: Scope, p: Metadata) {
  return confirmed(
    await authenticatedJSON(path(scope), {
      method: 'POST',
      body: metadata(scope, p),
    }),
    1,
  )
}
export async function update(
  scope: Scope,
  id: string,
  p: Metadata,
  revision: number,
) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(scope, id), {
      method: 'PUT',
      body: { ...metadata(scope, p), expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function transition(
  scope: Scope,
  id: string,
  status: State,
  revision: number,
) {
  expected(revision)
  if (!(scope.planID ? milestoneStates : planStates).some((s) => s === status))
    throw new APIError(0, 'invalid_request')
  return confirmed(
    await authenticatedJSON(path(scope, id) + '/status', {
      method: 'POST',
      body: { status, expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function archive(scope: Scope, id: string, revision: number) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(scope, id) + '/archive', {
      method: 'POST',
      body: { confirm: true, expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function candidates(
  scope: Scope,
  cursor: string,
  search: string,
  signal: AbortSignal,
) {
  if (
    !scope.planID ||
    [...search.trim()].length > 100 ||
    /[\p{Cc}]/u.test(search)
  )
    throw new APIError(0, 'invalid_request')
  const q = paging(cursor)
  if (search.trim()) q.set('q', search.trim())
  const p = parseCandidates(
    await authenticatedJSON(
      `${path({ clientID: scope.clientID }, scope.planID)}/task-candidates?${q}`,
      { signal },
    ),
  )
  if (p.page.limit !== 25) throw new APIError(0, 'invalid_response')
  return p
}
export async function links(
  scope: Scope,
  id: string,
  cursor: string,
  archived: Filter['archived'],
  signal: AbortSignal,
) {
  if (!scope.planID || !['false', 'true', 'all'].includes(archived))
    throw new APIError(0, 'invalid_request')
  const q = paging(cursor)
  q.set('archived', archived)
  const p = parseLinks(
    await authenticatedJSON(`${path(scope, id)}/task-links?${q}`, { signal }),
  )
  if (p.page.limit !== 25) throw new APIError(0, 'invalid_response')
  return p
}
export async function replaceLinks(
  scope: Scope,
  id: string,
  ids: string[],
  revision: number,
) {
  expected(revision)
  if (!scope.planID) throw new APIError(0, 'invalid_request')
  return confirmed(
    await authenticatedJSON(path(scope, id) + '/task-links', {
      method: 'PUT',
      body: { task_ids: linkSetSchema.parse(ids), expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
