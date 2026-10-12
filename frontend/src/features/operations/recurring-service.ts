import { automationFailure } from './automation-models'
import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { uuid, exact, pagination, checked, data } from './models'
import { dateSchema, revisionSchema } from '../billing/models'
const instant = z.string().datetime()
export const template = z
  .object({
    id: uuid,
    client_id: uuid,
    created_by: uuid,
    managed_by: uuid,
    manager_name: z.string().max(100),
    automation_failure: automationFailure,
    status: z.enum(['active', 'paused', 'cancelled', 'expired']),
    next_date: dateSchema,
    revision: revisionSchema,
    generated_count: exact,
    current_version: revisionSchema,
    created_at: instant,
    updated_at: instant,
    title: z.string().min(1).max(200),
    description: z.string().max(8000),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    website_id: uuid.nullable(),
    website_name: z.string().max(200).nullable(),
    assignee_id: uuid,
    assignee_name: z.string().max(100),
    supervisor_id: uuid.nullable(),
    supervisor_name: z.string().max(100).nullable(),
    start_date: dateSchema,
    end_date: dateSchema.nullable(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(365),
    anchor_day: z.number().int().min(1).max(31),
    due_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(100),
    occurrence_limit: z.number().int().min(1).max(100000).nullable(),
  })
  .strict()
export type Template = z.infer<typeof template>
const occurrence = z
  .object({
    id: uuid,
    template_id: uuid,
    client_id: uuid,
    version_id: uuid,
    task_id: uuid,
    scheduled_date: dateSchema,
    created_at: instant,
    title: z.string().max(200),
    status: z.enum([
      'backlog',
      'todo',
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
    ]),
    due_at: instant.nullable(),
    assignee_name: z.string().max(100).nullable(),
  })
  .strict()
export const templateVersion = template
  .omit({
    managed_by: true,
    manager_name: true,
    automation_failure: true,
    status: true,
    next_date: true,
    revision: true,
    generated_count: true,
    current_version: true,
    updated_at: true,
    created_by: true,
  })
  .safeExtend({ template_id: uuid, number: revisionSchema })
  .strict()
const receipt = z.object({ id: uuid, replayed: z.boolean() }).strict()
function base(client: string, id?: string) {
  if (!uuid.safeParse(client).success || (id && !uuid.safeParse(id).success))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/recurring-tasks${id ? '/' + id : ''}`
}
async function page<T extends { id: string; client_id: string }>(
  path: string,
  schema: z.ZodType<T>,
  client: string,
  cursor: string,
  signal: AbortSignal,
  bind: (v: T) => boolean = () => true,
) {
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) {
    if (!uuid.safeParse(cursor).success)
      throw new APIError(0, 'invalid_request')
    q.set('cursor', cursor)
  }
  const v = checked(
    z.object({ data: z.array(schema).max(25), page: pagination }).strict(),
    await authenticatedJSON(`${path}?${q}`, { signal }),
  )
  if (
    v.data.some(
      (r, i) =>
        r.client_id !== client ||
        !bind(r) ||
        (cursor && r.id <= cursor) ||
        (i > 0 && r.id <= v.data[i - 1]!.id),
    ) ||
    (v.page.next_cursor !== null && v.page.next_cursor !== v.data.at(-1)?.id)
  )
    throw new APIError(0, 'invalid_response')
  return v
}
export const list = (client: string, cursor: string, signal: AbortSignal) =>
  page(base(client), template, client, cursor, signal)
export const occurrences = (
  client: string,
  id: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client, id)}/occurrences`,
    occurrence,
    client,
    cursor,
    signal,
    (v) => v.template_id === id,
  )
export const versions = (
  client: string,
  id: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client, id)}/versions`,
    templateVersion,
    client,
    cursor,
    signal,
    (v) => v.template_id === id,
  )
export async function supervisors(
  client: string,
  assignee: string,
  cursor: string,
  signal: AbortSignal,
) {
  if (
    !uuid.safeParse(assignee).success ||
    (cursor && !uuid.safeParse(cursor).success)
  )
    throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25', assignee })
  if (cursor) q.set('cursor', cursor)
  const v = checked(
    z
      .object({
        data: z
          .array(
            z.object({ id: uuid, display_name: z.string().max(100) }).strict(),
          )
          .max(25),
        page: pagination,
      })
      .strict(),
    await authenticatedJSON(`${base(client)}/supervisors?${q}`, { signal }),
  )
  if (
    v.data.some(
      (r, i) =>
        (cursor && r.id <= cursor) || (i > 0 && r.id <= v.data[i - 1]!.id),
    ) ||
    (v.page.next_cursor !== null && v.page.next_cursor !== v.data.at(-1)?.id)
  )
    throw new APIError(0, 'invalid_response')
  return v
}
export async function read(client: string, id: string, signal: AbortSignal) {
  const v = data(
    template,
    await authenticatedJSON(base(client, id), { signal }),
  )
  if (v.id !== id || v.client_id !== client)
    throw new APIError(0, 'invalid_response')
  return v
}
export async function write(
  client: string,
  id: string | undefined,
  body: unknown,
  generate = false,
) {
  const v = data(
    receipt,
    await authenticatedJSON(base(client, id) + (generate ? '/generate' : ''), {
      method: id && !generate ? 'PUT' : 'POST',
      body,
    }),
  )
  if (id && !generate && v.id !== id) throw new APIError(0, 'invalid_response')
  return v
}
