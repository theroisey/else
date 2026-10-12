import { z } from '../../lib/validation'
import { authenticatedJSON, APIError } from '../../services/authenticated'
import { csrfToken } from '../auth/auth-service'
import { isUUID } from '../auth/session'
import * as m from './models'
function path(client: string, id?: string) {
  if (!isUUID(client) || (id !== undefined && !isUUID(id)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/requests${id ? '/' + id : ''}`
}
export async function today(
  signal: AbortSignal,
  filters = new URLSearchParams(),
) {
  return m.data(
    m.todaySchema,
    await authenticatedJSON(
      '/api/v1/today' + (filters.size ? '?' + filters.toString() : ''),
      { signal },
    ),
  )
}
export async function list(
  client: string | undefined,
  query: URLSearchParams,
  signal: AbortSignal,
) {
  const page = m.checked(
    m.pageSchema,
    await authenticatedJSON(
      `${client ? path(client) : '/api/v1/requests'}?${query}`,
      { signal },
    ),
  )
  if (client && page.data.some((v) => v.client_id !== client))
    throw new APIError(0, 'invalid_response')
  const cursor = query.get('cursor'),
    descending = query.get('sort') === '-id',
    selected = client ?? query.get('client_id')
  if (
    page.page.limit !== 25 ||
    page.data.some(
      (v, i) =>
        (selected && v.client_id !== selected) ||
        (cursor && (descending ? v.id >= cursor : v.id <= cursor)) ||
        (i > 0 &&
          (descending
            ? v.id >= page.data[i - 1]!.id
            : v.id <= page.data[i - 1]!.id)),
    ) ||
    (page.page.next_cursor !== null &&
      page.page.next_cursor !== page.data.at(-1)?.id)
  )
    throw new APIError(0, 'invalid_response')
  return page
}
export async function detail(client: string, id: string, signal: AbortSignal) {
  const v = m.data(
    m.detailSchema,
    await authenticatedJSON(path(client, id), { signal }),
  )
  if (v.id !== id || v.client_id !== client)
    throw new APIError(0, 'invalid_response')
  return v
}
export async function timeline(
  client: string,
  id: string,
  after: string,
  signal: AbortSignal,
) {
  const q = new URLSearchParams({ limit: '25' })
  if (after) q.set('after', after)
  const v = m.checked(
    m.timelineSchema,
    await authenticatedJSON(`${path(client, id)}/timeline?${q}`, { signal }),
  )
  if (
    v.data.some(
      (e) => e.request_id !== id || BigInt(e.sequence) <= BigInt(after || '0'),
    ) ||
    v.data.some(
      (e, i) => i > 0 && BigInt(e.sequence) <= BigInt(v.data[i - 1]!.sequence),
    )
  )
    throw new APIError(0, 'invalid_response')
  return v
}
export async function developers(
  client: string,
  cursor: string,
  signal: AbortSignal,
) {
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return m.checked(
    z
      .object({
        data: z
          .array(
            z
              .object({ id: m.uuid, display_name: z.string().min(1).max(100) })
              .strict(),
          )
          .max(25),
        page: m.pagination,
      })
      .strict(),
    await authenticatedJSON(`${path(client)}/developers?${q}`, { signal }),
  )
}
export async function create(client: string, body: unknown) {
  return m.data(
    m.mutationSchema,
    await authenticatedJSON(path(client), { method: 'POST', body }),
  )
}
export async function act(
  client: string,
  id: string,
  action: string,
  body: unknown,
) {
  if (!Object.hasOwn(m.actionLabels, action))
    throw new APIError(0, 'invalid_request')
  const v = m.data(
    m.mutationSchema,
    await authenticatedJSON(`${path(client, id)}/${action}`, {
      method: 'POST',
      body,
    }),
  )
  if (v.id !== id) throw new APIError(0, 'invalid_response')
  return v
}
export async function inbox(cursor: string, signal: AbortSignal) {
  const q = new URLSearchParams({ limit: '25', sort: '-id' })
  if (cursor) q.set('cursor', cursor)
  return m.checked(
    m.inboxSchema,
    await authenticatedJSON(`/api/v1/notifications?${q}`, { signal }),
  )
}
export async function mark(id: string) {
  if (id !== 'all' && !isUUID(id)) throw new APIError(0, 'invalid_request')
  return m.data(
    z.object({ marked: z.literal(true) }).strict(),
    await authenticatedJSON(`/api/v1/notifications/${id}/read`, {
      method: 'POST',
    }),
  )
}
export function evidenceURL(client: string, id: string) {
  if (!isUUID(client) || !isUUID(id)) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/evidence/${id}`
}
export async function upload(client: string, id: string, file: File) {
  if (
    file.size > 8 * 1024 * 1024 ||
    file.size === 0 ||
    !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(
      file.type,
    )
  )
    throw new APIError(0, 'invalid_request')
  const response = await fetch(evidenceURL(client, id), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': file.type,
      'X-CSRF-Token': csrfToken(),
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  })
  if (
    response.headers.get('Content-Type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new APIError(0, 'invalid_response')
  const raw: unknown = await response.json()
  if (!response.ok) throw new APIError(response.status, 'request_failed')
  const result = m.data(
    z.object({ id: m.uuid, replayed: z.boolean() }).strict(),
    raw,
  )
  if (result.id !== id) throw new APIError(0, 'invalid_response')
  return result
}

export async function discard(client: string, id: string) {
  return m.data(
    z.object({ discarded: z.literal(true) }).strict(),
    await authenticatedJSON(evidenceURL(client, id), { method: 'DELETE' }),
  )
}

export async function deliveries(
  client: string,
  id: string,
  before: string,
  signal: AbortSignal,
) {
  const q = new URLSearchParams({ limit: '25', before })
  const v = m.checked(
    m.deliveryPageSchema,
    await authenticatedJSON(`${path(client, id)}/deliveries?${q}`, { signal }),
  )
  if (
    v.data.some(
      (d) => d.request_id !== id || BigInt(d.number) >= BigInt(before),
    ) ||
    v.data.some((d, i) => i > 0 && d.number >= v.data[i - 1]!.number) ||
    v.reviews.some((r) => !v.data.some((d) => d.id === r.delivery_id))
  )
    throw new APIError(0, 'invalid_response')
  return v
}
