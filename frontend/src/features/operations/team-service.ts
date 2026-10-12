import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { uuid, exact, pagination, checked, data } from './models'
const instant = z.string().datetime()
export const teamSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(100),
    leader_id: uuid,
    leader_name: z.string().max(100),
    revision: exact,
    created_at: instant,
    updated_at: instant,
    archived_at: instant.nullable(),
  })
  .strict()
export type Team = z.infer<typeof teamSchema>
const user = z
  .object({
    id: uuid,
    display_name: z.string().max(100),
    status: z.literal('active'),
  })
  .strict()
const member = z
  .object({
    id: uuid,
    team_id: uuid,
    user_id: uuid,
    display_name: z.string().max(100),
    status: z.enum(['active', 'disabled']),
    assigned_at: instant,
    revoked_at: instant.nullable(),
    brands: exact,
    active_tasks: exact,
  })
  .strict()
const assignment = z
  .object({
    id: uuid,
    client_id: uuid,
    brand_name: z.string().max(200),
    team_id: uuid,
    user_id: uuid,
    display_name: z.string().max(100),
    responsibility: z.string().max(300),
    assigned_at: instant,
    revoked_at: instant.nullable(),
  })
  .strict()
const page = <T>(schema: z.ZodType<T>) =>
  z.object({ data: z.array(schema).max(25), page: pagination }).strict()
function ordered<T extends { id: string }>(
  v: { data: T[]; page: { next_cursor: string | null } },
  cursor: string,
) {
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
function base(id: string) {
  if (!uuid.safeParse(id).success) throw new APIError(0, 'invalid_request')
  return `/api/v1/teams/${id}`
}
function q(cursor: string) {
  const p = new URLSearchParams({ limit: '25' })
  if (cursor) p.set('cursor', cursor)
  return p
}
export async function list(cursor: string, signal: AbortSignal) {
  return ordered(
    checked(
      page(teamSchema),
      await authenticatedJSON(`/api/v1/teams?${q(cursor)}`, { signal }),
    ),
    cursor,
  )
}
export async function read(id: string, signal: AbortSignal) {
  const v = data(teamSchema, await authenticatedJSON(base(id), { signal }))
  if (v.id !== id) throw new APIError(0, 'invalid_response')
  return v
}
export async function create(body: unknown) {
  return data(
    teamSchema,
    await authenticatedJSON('/api/v1/teams', { method: 'POST', body }),
  )
}
export async function update(id: string, body: unknown) {
  return data(
    teamSchema,
    await authenticatedJSON(base(id), { method: 'PUT', body }),
  )
}
export async function directory(
  cursor: string,
  search: string,
  signal: AbortSignal,
) {
  const p = q(cursor)
  if (search) p.set('q', search)
  return ordered(
    checked(
      page(user),
      await authenticatedJSON(`/api/v1/teams/directory?${p}`, { signal }),
    ),
    cursor,
  )
}
export async function members(id: string, cursor: string, signal: AbortSignal) {
  const v = checked(
    page(member),
    await authenticatedJSON(`${base(id)}/members?${q(cursor)}`, { signal }),
  )
  if (v.data.some((m) => m.team_id !== id))
    throw new APIError(0, 'invalid_response')
  return ordered(v, cursor)
}
export async function assignments(
  id: string,
  cursor: string,
  signal: AbortSignal,
) {
  const v = checked(
    page(assignment),
    await authenticatedJSON(`${base(id)}/assignments?${q(cursor)}`, { signal }),
  )
  if (v.data.some((m) => m.team_id !== id))
    throw new APIError(0, 'invalid_response')
  return ordered(v, cursor)
}
export async function assign(id: string, body: unknown) {
  return data(
    teamSchema,
    await authenticatedJSON(`${base(id)}/assignments`, { method: 'PUT', body }),
  )
}
export async function membership(id: string, body: unknown) {
  return data(
    teamSchema,
    await authenticatedJSON(`${base(id)}/members`, { method: 'PUT', body }),
  )
}

export async function history(id: string, before: string, signal: AbortSignal) {
  const q = new URLSearchParams({ limit: '25' })
  if (before) q.set('before', before)
  const row = z
    .object({
      id: uuid,
      team_id: uuid,
      revision: exact,
      previous_leader_id: uuid.nullable(),
      previous_leader_name: z.string().max(100).nullable(),
      leader_id: uuid,
      leader_name: z.string().max(100),
      actor_id: uuid,
      actor_name: z.string().max(100),
      created_at: instant,
    })
    .strict()
  const v = checked(
    z
      .object({
        data: z.array(row).max(25),
        page: z
          .object({ limit: z.literal(25), next_before: exact.nullable() })
          .strict(),
      })
      .strict(),
    await authenticatedJSON(`${base(id)}/history?${q}`, { signal }),
  )
  if (
    v.data.some(
      (r) =>
        r.team_id !== id || (before && BigInt(r.revision) >= BigInt(before)),
    ) ||
    v.data.some(
      (r, i) => i > 0 && BigInt(r.revision) >= BigInt(v.data[i - 1]!.revision),
    )
  )
    throw new APIError(0, 'invalid_response')
  return v
}
