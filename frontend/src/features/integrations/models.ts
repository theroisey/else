import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { instant } from '../../lib/time'
import { isUUID } from '../auth/session'

const uuid = z.string().refine(isUUID)
export const revisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .pipe(z.string().refine((v) => BigInt(v) <= 9223372036854775807n))
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((v) => {
    const d = new Date(v)
    return (
      Number.isFinite(d.getTime()) &&
      d.getUTCFullYear() >= 1 &&
      d.toISOString().slice(0, 19) === v.slice(0, 19)
    )
  })
export const labels = {
  pending: 'Pending',
  connected: 'Connected (recorded)',
  disconnect_pending: 'Disconnect pending',
  revocation_failed: 'Local use disabled · Manual action required',
  disconnected: 'Disconnected (recorded)',
  reauthorization_required: 'Reauthorization required',
} as const
const connectionSchema = z
  .object({
    id: uuid,
    client_id: uuid,
    provider: z.literal('meta_ads'),
    state: z.enum([
      'pending',
      'connected',
      'disconnect_pending',
      'revocation_failed',
      'disconnected',
      'reauthorization_required',
    ]),
    revision: revisionSchema,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .refine((v) => {
    try {
      return instant(v.updated_at) >= instant(v.created_at)
    } catch {
      return false
    }
  })
export type Connection = z.infer<typeof connectionSchema>

// This versioned keyset is public metadata, not an authorization token.
export function cursorAfter(value: string, clientID: string): string {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error()
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    const [version, client, after, extra] = decoded.split('|')
    if (
      version !== 'v1' ||
      client !== clientID ||
      !isUUID(after) ||
      extra !== undefined ||
      btoa(decoded)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '') !== value
    )
      throw new Error()
    return after
  } catch {
    throw new APIError(0, 'invalid_request')
  }
}
export function parseConnection(body: unknown, clientID: string, id: string) {
  const result = z.object({ data: connectionSchema }).strict().safeParse(body)
  if (
    !result.success ||
    result.data.data.client_id !== clientID ||
    result.data.data.id !== id
  )
    throw new APIError(0, 'invalid_response')
  return result.data.data
}
export function parsePage(body: unknown, clientID: string, after = '') {
  const result = z
    .object({
      data: z.array(connectionSchema).max(25),
      page: z
        .object({
          limit: z.literal(25),
          next_cursor: z.string().nullable(),
        })
        .strict(),
    })
    .strict()
    .safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  const { data, page } = result.data
  if (
    data.some(
      (v, i) =>
        v.client_id !== clientID || v.id <= (i ? data[i - 1]!.id : after),
    )
  )
    throw new APIError(0, 'invalid_response')
  if (page.next_cursor !== null) {
    try {
      if (
        data.length !== 25 ||
        cursorAfter(page.next_cursor, clientID) !== data.at(-1)?.id
      )
        throw new Error()
    } catch {
      throw new APIError(0, 'invalid_response')
    }
  }
  return result.data
}
export function canDisable(record: Connection) {
  return (
    [
      'pending',
      'connected',
      'disconnect_pending',
      'reauthorization_required',
    ].includes(record.state) &&
    revisionSchema.safeParse(record.revision).success &&
    BigInt(record.revision) < 9223372036854775807n
  )
}
export function parseDisconnect(body: unknown, previous: Connection) {
  const result = z
    .object({
      data: connectionSchema,
      revocation: z
        .object({
          status: z.literal('unavailable'),
          manual_action_required: z.literal(true),
        })
        .strict(),
    })
    .strict()
    .safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  const next = result.data.data
  const expected =
    BigInt(previous.revision) +
    (previous.state === 'revocation_failed' ? 0n : 1n)
  if (
    next.id !== previous.id ||
    next.client_id !== previous.client_id ||
    next.provider !== previous.provider ||
    next.state !== 'revocation_failed' ||
    BigInt(next.revision) !== expected ||
    next.created_at !== previous.created_at ||
    instant(next.updated_at) < instant(previous.updated_at)
  )
    throw new APIError(0, 'invalid_response')
  return result.data
}
