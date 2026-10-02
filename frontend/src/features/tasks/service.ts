import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  metadataSchema,
  parseCandidates,
  parseMutation,
  parsePage,
  parseTask,
  statuses,
  priorities,
} from './models'
import type { Filter, Metadata, TaskStatus } from './models'
function path(client: string, id?: string) {
  if (!isUUID(client) || (id !== undefined && !isUUID(id))) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/tasks${id ? '/' + id : ''}`
}
function cursorQuery(cursor: string) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return q
}
export async function list(client: string, f: Filter, cursor: string, signal: AbortSignal) {
  if (
    !['all', ...statuses].includes(f.status) ||
    !['all', ...priorities].includes(f.priority) ||
    !['id', '-id'].includes(f.sort) ||
    !['false', 'true', 'all'].includes(f.archived) ||
    (f.assignee !== '' && f.assignee !== 'unassigned' && !isUUID(f.assignee)) ||
    [...f.q.trim()].length > 100 ||
    [...f.tag.trim()].length > 40 ||
    /[\p{Cc}]/u.test(f.q + f.tag)
  )
    throw new APIError(0, 'invalid_request')
  const q = cursorQuery(cursor)
  q.set('status', f.status)
  q.set('priority', f.priority)
  q.set('archived', f.archived)
  q.set('sort', f.sort)
  if (f.q.trim()) q.set('q', f.q.trim())
  if (f.tag.trim()) q.set('tag', f.tag.trim().toLowerCase())
  if (f.assignee) q.set('assignee', f.assignee)
  const page = parsePage(await authenticatedJSON(`${path(client)}?${q}`, { signal }))
  if (page.page.limit !== 25 || page.data.some((t) => t.client_id !== client.toLowerCase()))
    throw new APIError(0, 'invalid_response')
  return page
}
export async function detail(client: string, id: string, signal?: AbortSignal) {
  const task = parseTask(await authenticatedJSON(path(client, id), signal ? { signal } : {}))
  if (task.id !== id.toLowerCase() || task.client_id !== client.toLowerCase())
    throw new APIError(0, 'invalid_response')
  return task
}
export async function candidates(client: string, cursor: string, signal: AbortSignal) {
  const page = parseCandidates(
    await authenticatedJSON(`${path(client)}/assignees?${cursorQuery(cursor)}`, { signal }),
  )
  if (page.page.limit !== 25) throw new APIError(0, 'invalid_response')
  return page
}
function expected(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER)
    throw new APIError(0, 'invalid_request')
}
function confirmed(body: unknown, revision: number, id?: string) {
  const result = parseMutation(body)
  if (result.revision !== revision || (id && result.id !== id.toLowerCase()))
    throw new APIError(0, 'invalid_response')
  return result
}
export async function create(client: string, metadata: Metadata, status: 'backlog' | 'todo') {
  if (status !== 'backlog' && status !== 'todo') throw new APIError(0, 'invalid_request')
  return confirmed(
    await authenticatedJSON(path(client), {
      method: 'POST',
      body: { ...metadataSchema.parse(metadata), status },
    }),
    1,
  )
}
export async function update(client: string, id: string, metadata: Metadata, revision: number) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(client, id), {
      method: 'PUT',
      body: { ...metadataSchema.parse(metadata), expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function transition(client: string, id: string, status: TaskStatus, revision: number) {
  expected(revision)
  if (!statuses.includes(status)) throw new APIError(0, 'invalid_request')
  return confirmed(
    await authenticatedJSON(`${path(client, id)}/status`, {
      method: 'POST',
      body: { status, expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
export async function archive(client: string, id: string, revision: number) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(`${path(client, id)}/archive`, {
      method: 'POST',
      body: { confirm: true, expected_revision: revision },
    }),
    revision + 1,
    id,
  )
}
