import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { instant } from '../../lib/time'
import { utcFromWall, wallClock } from './time'
export const states = ['pending', 'completed', 'dismissed'] as const
export const labels = { pending: 'Pending', completed: 'Completed', dismissed: 'Dismissed' }
export const uuid = z
  .string()
  .refine(isUUID)
  .transform((v) => v.toLowerCase())
const text = (max: number, required = false, multiline = false) =>
  z
    .string()
    .transform((v) => v.replaceAll('\r\n', '\n').trim())
    .refine(
      (v) =>
        [...v].length <= max &&
        (!required || !!v) &&
        !/[\p{Cc}]/u.test(multiline ? v.replaceAll('\n', '') : v),
      `Use ${required ? '1–' : 'up to '}${max} characters${multiline ? '; only line breaks are supported.' : ' without control characters.'}`,
    )
const zone = z
  .string()
  .max(100)
  .regex(/^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/)
const local = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/)
  .refine((v) => {
    try {
      wallClock(v)
      return true
    } catch {
      return false
    }
  })
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((v) => {
    try {
      return instant(v) === instant(utcFromWall(v.slice(0, -1), 0))
    } catch {
      return false
    }
  })
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const resourceSchema = z
  .object({ kind: z.enum(['task', 'plan', 'milestone']), id: uuid })
  .strict()
export type Resource = z.infer<typeof resourceSchema>
export const profileSchema = z
  .object({
    title: text(200, true),
    description: text(8000, false, true),
    owner_id: uuid,
    scheduled_local: local,
    timezone: zone,
    utc_offset_seconds: z.number().int().min(-86399).max(86399),
    resource: resourceSchema.nullable(),
  })
  .refine(
    (v) => {
      try {
        utcFromWall(v.scheduled_local, v.utc_offset_seconds)
        return true
      } catch {
        return false
      }
    },
    { path: ['scheduled_local'], message: 'Check the local date and UTC year bounds.' },
  )
export type Profile = z.infer<typeof profileSchema>
const base = z.object({
  id: uuid,
  client_id: uuid,
  created_by: uuid,
  owner_id: uuid,
  title: text(200, true),
  status: z.enum(states),
  scheduled_at: timestamp,
  scheduled_local: local,
  timezone: zone,
  utc_offset_seconds: z.number().int().min(-86399).max(86399),
  resource: resourceSchema.nullable(),
  is_due: z.boolean(),
  completed_at: timestamp.nullable(),
  dismissed_at: timestamp.nullable(),
  revision,
  created_at: timestamp,
  updated_at: timestamp,
})
function consistent(v: z.infer<typeof base>) {
  try {
    return (
      instant(v.scheduled_at) === instant(utcFromWall(v.scheduled_local, v.utc_offset_seconds)) &&
      (v.status === 'completed') === (v.completed_at !== null) &&
      (v.status === 'dismissed') === (v.dismissed_at !== null) &&
      (!v.is_due || v.status === 'pending') &&
      instant(v.updated_at) >= instant(v.created_at) &&
      [v.completed_at, v.dismissed_at].every((t) => !t || instant(t) >= instant(v.created_at))
    )
  } catch {
    return false
  }
}
const summary = base.refine(consistent),
  record = base.extend({ description: text(8000, false, true) }).refine(consistent)
export type Summary = z.infer<typeof summary>
export type RecordData = z.infer<typeof record>
function page<T extends z.ZodType<{ id: string }>>(item: T) {
  return z
    .object({
      data: z.array(item).max(25),
      page: z.object({ limit: z.literal(25), next_cursor: uuid.nullable() }),
    })
    .refine(
      (p) =>
        new Set(p.data.map((v) => v.id)).size === p.data.length &&
        (!p.page.next_cursor || (p.data.length === 25 && p.page.next_cursor === p.data.at(-1)?.id)),
    )
}
function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const r = schema.safeParse(body)
  if (!r.success) throw new APIError(0, 'invalid_response')
  return r.data
}
export const parsePage = (body: unknown) => parse(page(summary), body)
export const parseRecord = (body: unknown) => parse(z.object({ data: record }), body).data
export const parseOwners = (body: unknown) =>
  parse(page(z.object({ id: uuid, display_name: text(120, true) }).strict()), body)
export const parseMutation = (body: unknown) =>
  parse(z.object({ data: z.object({ id: uuid, revision }) }), body).data
export interface Filter {
  q: string
  status: (typeof states)[number] | 'all'
  due: 'all' | 'due' | 'upcoming'
  owner: string
  sort: 'id' | '-id'
}
export const defaultFilter: Filter = {
  q: '',
  status: 'pending',
  due: 'all',
  owner: 'any',
  sort: 'id',
}
export const pagePath = (client: string, id?: string) =>
  `/app/clients/${client}/reminders${id ? '/' + id : ''}`
