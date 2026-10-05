import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { connectionSchema } from '../integrations/models'

export const websiteSchema = z
  .object({
    id: z.string().refine(isUUID),
    client_id: z.string().refine(isUUID),
    name: z.string().min(1).max(200),
    url: z.string().min(1).max(2048),
    domain: z.string().max(253),
    description: z.string().max(4000),
    status: z.enum(['active', 'archived']),
    is_primary: z.boolean(),
    needs_review: z.boolean(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    archived_at: z.string().datetime().nullable(),
  })
  .refine(
    (v) =>
      (v.status === 'archived') === (v.archived_at !== null) &&
      (!v.is_primary || (v.status === 'active' && !v.needs_review)),
  )
export type Website = z.infer<typeof websiteSchema>
export type WebsiteDraft = Pick<Website, 'name' | 'url' | 'description'>
export const emptyWebsite: WebsiteDraft = {
  name: '',
  url: '',
  description: '',
}
function endpoint(client: string, website?: string) {
  if (!isUUID(client) || (website !== undefined && !isUUID(website)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/websites${website ? '/' + website : ''}`
}
const pagination = z.object({
  limit: z.number().int().min(1).max(100),
  next_cursor: z.string().refine(isUUID).nullable(),
})
function checked<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
export async function list(
  client: string,
  cursor: string,
  status: 'active' | 'archived' | 'all',
  signal: AbortSignal,
) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({ limit: '25', status })
  if (cursor) query.set('cursor', cursor)
  const page = checked(
    z.object({ data: z.array(websiteSchema).max(25), page: pagination }),
    await authenticatedJSON(`${endpoint(client)}?${query}`, { signal }),
  )
  if (
    page.data.some((w) => w.client_id !== client) ||
    new Set(page.data.map((w) => w.id)).size !== page.data.length
  )
    throw new APIError(0, 'invalid_response')
  return page
}
export async function detail(
  client: string,
  website: string,
  signal?: AbortSignal,
) {
  const { data } = checked(
    z.object({ data: websiteSchema }),
    await authenticatedJSON(
      endpoint(client, website),
      signal ? { signal } : {},
    ),
  )
  if (data.id !== website || data.client_id !== client)
    throw new APIError(0, 'invalid_response')
  return data
}
function mutation(body: unknown, expected: number, id?: string) {
  const result = checked(
    z.object({
      data: z.object({
        id: z.string().refine(isUUID),
        revision: z.number().int().positive(),
      }),
    }),
    body,
  ).data
  if (result.revision !== expected || (id !== undefined && result.id !== id))
    throw new APIError(0, 'invalid_response')
  return result
}
export async function save(
  client: string,
  draft: WebsiteDraft,
  record?: Website,
) {
  return mutation(
    await authenticatedJSON(endpoint(client, record?.id), {
      method: record ? 'PUT' : 'POST',
      body: {
        ...draft,
        domain: '',
        ...(record ? { expected_revision: record.revision } : {}),
      },
    }),
    (record?.revision ?? 0) + 1,
    record?.id,
  )
}
export async function action(record: Website, action: 'primary' | 'archive') {
  return mutation(
    await authenticatedJSON(
      `${endpoint(record.client_id, record.id)}/${action}`,
      {
        method: 'POST',
        body: { expected_revision: record.revision, confirm: true },
      },
    ),
    record.revision + 1,
    record.id,
  )
}
export async function connections(
  client: string,
  website: string,
  cursor: string,
  signal: AbortSignal,
) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({ limit: '25' })
  if (cursor) query.set('cursor', cursor)
  const page = checked(
    z.object({ data: z.array(connectionSchema).max(25), page: pagination }),
    await authenticatedJSON(
      `${endpoint(client, website)}/connections?${query}`,
      { signal },
    ),
  )
  if (page.data.some((v) => v.client_id !== client))
    throw new APIError(0, 'invalid_response')
  return page
}
export async function bind(
  record: Website,
  connection: string,
  attach: boolean,
) {
  if (!isUUID(connection)) throw new APIError(0, 'invalid_request')
  return mutation(
    await authenticatedJSON(
      `${endpoint(record.client_id, record.id)}/connections`,
      {
        method: 'POST',
        body: {
          connection_id: connection,
          expected_revision: record.revision,
          attach,
          confirm: true,
        },
      },
    ),
    record.revision + 1,
    record.id,
  )
}
export function websiteBase(client: string, website?: string) {
  if (!isUUID(client) || (website !== undefined && !isUUID(website)))
    throw new APIError(0, 'invalid_request')
  return `/app/clients/${client}${website ? '/websites/' + website : ''}`
}
export function websiteAPIBase(client: string, website?: string) {
  if (!isUUID(client) || (website !== undefined && !isUUID(website)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}${website ? '/websites/' + website : ''}`
}
export async function activity(
  client: string,
  website: string,
  cursor: string,
  signal: AbortSignal,
) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({ limit: '25' })
  if (cursor) query.set('cursor', cursor)
  const item = z.object({
    id: z.string().refine(isUUID),
    client_id: z.string().refine(isUUID),
    resource_id: z.string().refine(isUUID),
    resource_kind: z.literal('website'),
    event_type: z.enum([
      'website.created',
      'website.updated',
      'website.archived',
    ]),
    occurred_at: z.string().datetime(),
    summary: z.string().max(40),
  })
  const page = checked(
    z.object({ data: z.array(item).max(25), page: pagination }),
    await authenticatedJSON(`${endpoint(client, website)}/activity?${query}`, {
      signal,
    }),
  )
  if (
    page.data.some((v) => v.client_id !== client || v.resource_id !== website)
  )
    throw new APIError(0, 'invalid_response')
  return page
}
