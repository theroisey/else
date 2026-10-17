import { z } from '../../lib/validation'
import { authenticatedJSON, APIError } from '../../services/authenticated'
import { uuid, exact, data } from '../operations/models'
const instant = z.string().datetime()
const scope = z.string().max(64)
export const statusSchema = z
  .object({
    enabled: z.boolean(),
    revision: exact,
    endpoint: z.string().url().max(2048),
    can_manage: z.boolean(),
    scopes: z.array(scope).max(32),
  })
  .strict()
export const applicationSchema = z
  .object({
    id: uuid,
    name: z.string().max(120),
    revision: exact,
    created_at: instant,
    revoked_at: instant.nullable(),
    redirect_uris: z.array(z.string().url().max(2048)).max(8),
    origins: z.array(z.string().url().max(512)).max(4),
  })
  .strict()
export const grantSchema = z
  .object({
    id: uuid,
    application_id: uuid,
    application_name: z.string().max(120),
    client_id: uuid.nullable(),
    scopes: z.string().max(2048),
    created_at: instant,
    expires_at: instant,
    revoked_at: instant.nullable(),
  })
  .strict()
export const consentSchema = z
  .object({
    id: uuid,
    application_name: z.string().max(120),
    redirect_uri: z.string().url().max(2048),
    scopes: z.array(scope).max(32),
    expires_at: instant,
  })
  .strict()
export const approvalSchema = z
  .object({
    id: uuid,
    tool_name: z.string().max(128),
    arguments: z.record(z.string(), z.unknown()),
    argument_digest: z.string().regex(/^[0-9a-f]{64}$/),
    command_id: uuid,
    client_id: uuid.nullable(),
    state: z.enum(['pending', 'approved', 'denied', 'expired', 'revoked']),
    expires_at: instant,
    consumed_at: instant.nullable(),
    application_name: z.string().max(120),
  })
  .strict()
export async function status(signal: AbortSignal) {
  return data(statusSchema, await authenticatedJSON('/api/v1/mcp', { signal }))
}
export async function page<T extends z.ZodType>(
  kind: 'applications' | 'grants',
  schema: T,
  signal: AbortSignal,
  cursor?: string,
) {
  const query = new URLSearchParams({ limit: '25' })
  if (cursor) query.set('cursor', uuid.parse(cursor))
  const raw = await authenticatedJSON(`/api/v1/mcp/${kind}?${query}`, {
    signal,
  })
  const parsed = z
    .object({
      data: z.array(schema).max(25),
      page: z
        .object({
          limit: z.number().int().min(1).max(25),
          next_cursor: uuid.nullable(),
        })
        .strict(),
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) throw new APIError(0, 'invalid_response')
  return parsed.data
}
export type MCPStatus = z.infer<typeof statusSchema>
