import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { instant } from '../../lib/time'
import { isUUID } from '../auth/session'

const uuid = z.string().refine(isUUID)
export const timestamp = z
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
const kind = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
export const eventType = z.string().refine((v) => {
  const [resource, action, extra] = v.split('.')
  return (
    v.split('.').length === 2 &&
    !extra &&
    kind.safeParse(resource).success &&
    (['created', 'updated', 'archived', 'deleted'].includes(action ?? '') ||
      (action === 'disabled' && resource === 'user') ||
      (action === 'permission_changed' && resource === 'role') ||
      (action === 'completed' && ['task', 'reminder'].includes(resource!)) ||
      (action === 'cancelled' && ['task', 'billing'].includes(resource!)) ||
      (action === 'payment_recorded' && resource === 'billing') ||
      (action === 'dismissed' && resource === 'reminder'))
  )
})
const requestID = z.string().regex(/^[A-Z2-7]{26}$/)
export const cursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
const summaryShape = {
  id: uuid,
  schema_version: z.literal(1),
  occurred_at: timestamp,
  actor_kind: z.enum(['user', 'system']),
  actor_user_id: uuid.nullable(),
  event_type: eventType,
  resource_kind: kind,
  resource_id: uuid,
  client_id: uuid.nullable(),
  request_id: requestID,
}
const summaryObject = z.object(summaryShape).strict()
export type Summary = z.infer<typeof summaryObject>
const summaryValid = (v: Summary) =>
  v.event_type.startsWith(v.resource_kind + '.') &&
  (v.actor_kind === 'user'
    ? v.actor_user_id !== null
    : v.actor_user_id === null)
const summary = summaryObject.refine(summaryValid)
const revision = z
  .string()
  .refine(
    (v) => /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n,
  )
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => {
    if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(v)) return false
    try {
      new Intl.DateTimeFormat('en', { timeZone: v })
      return true
    } catch {
      return false
    }
  })
const snapshot = z
  .object({
    exists: z.boolean().optional(),
    revision: revision.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    task_status: z
      .enum([
        'backlog',
        'todo',
        'in_progress',
        'blocked',
        'review',
        'done',
        'cancelled',
      ])
      .optional(),
    planning_status: z
      .enum([
        'draft',
        'active',
        'completed',
        'cancelled',
        'planned',
        'in_progress',
      ])
      .optional(),
    reminder_status: z.enum(['pending', 'completed', 'dismissed']).optional(),
    reminder_scheduled_at: timestamp.optional(),
    reminder_timezone: timezone.optional(),
  })
  .strict()
export type Snapshot = z.infer<typeof snapshot>
const detail = z
  .object({
    ...summaryShape,
    before_state: snapshot.nullable(),
    after_state: snapshot.nullable(),
    metadata: z.object({ source: z.enum(['http', 'job', 'cli']) }).strict(),
  })
  .strict()
  .refine(summaryValid)
  .refine((v) =>
    [v.before_state, v.after_state].every(
      (s) =>
        !s ||
        ((s.task_status === undefined || v.resource_kind === 'task') &&
          (s.planning_status === undefined ||
            (v.resource_kind === 'plan' &&
              ['draft', 'active', 'completed', 'cancelled'].includes(
                s.planning_status,
              )) ||
            (v.resource_kind === 'milestone' &&
              ['planned', 'in_progress', 'completed', 'cancelled'].includes(
                s.planning_status,
              ))) &&
          ([
            s.reminder_status,
            s.reminder_scheduled_at,
            s.reminder_timezone,
          ].every((x) => x === undefined) ||
            v.resource_kind === 'reminder') &&
          (s.reminder_scheduled_at === undefined) ===
            (s.reminder_timezone === undefined)),
    ),
  )
export type Detail = z.infer<typeof detail>
const page = z
  .object({
    data: z.array(summary).max(25),
    page: z
      .object({ limit: z.literal(25), next_cursor: cursorSchema.nullable() })
      .strict(),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.data.map((v) => v.id)).size === p.data.length &&
      (!p.page.next_cursor || p.data.length === 25) &&
      p.data.every(
        (v, i) =>
          timestamp.safeParse(v.occurred_at).success &&
          (!i ||
            (timestamp.safeParse(p.data[i - 1]!.occurred_at).success &&
              (instant(p.data[i - 1]!.occurred_at) > instant(v.occurred_at) ||
                (instant(p.data[i - 1]!.occurred_at) ===
                  instant(v.occurred_at) &&
                  p.data[i - 1]!.id > v.id)))),
      ),
  )
export function parsePage(body: unknown) {
  const result = page.safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
export function parseDetail(body: unknown) {
  const result = z.object({ data: detail }).strict().safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data.data
}
export const markerLabels = {
  exists: 'Record exists',
  revision: 'Revision',
  status: 'Account status',
  task_status: 'Task status',
  planning_status: 'Planning status',
  reminder_status: 'Reminder status',
  reminder_scheduled_at: 'Reminder scheduled time (UTC)',
  reminder_timezone: 'Reminder timezone',
} satisfies Record<keyof Snapshot, string>
export function differences(before: Snapshot | null, after: Snapshot | null) {
  return (Object.keys(markerLabels) as (keyof Snapshot)[])
    .filter((key) => before?.[key] !== after?.[key])
    .map((key) => ({
      key,
      label: markerLabels[key],
      before: before?.[key],
      after: after?.[key],
    }))
}
export function markerValue(
  value: Snapshot[keyof Snapshot],
  key: keyof Snapshot,
) {
  return value === undefined
    ? 'Not recorded'
    : typeof value === 'boolean'
      ? value
        ? 'Yes'
        : 'No'
      : key.endsWith('status')
        ? value.replaceAll('_', ' ')
        : value
}
export function snapshotState(value: Snapshot | null) {
  return value === null
    ? 'Not recorded'
    : Object.keys(value).length
      ? 'Recorded markers'
      : 'Empty snapshot'
}
export const filterKeys = [
  'actor_id',
  'actor_kind',
  'event_type',
  'client_id',
  'resource_kind',
  'resource_id',
  'request_id',
  'from',
  'to',
] as const
export type Filters = Record<(typeof filterKeys)[number], string>
export const emptyFilters: Filters = {
  actor_id: '',
  actor_kind: '',
  event_type: '',
  client_id: '',
  resource_kind: '',
  resource_id: '',
  request_id: '',
  from: '',
  to: '',
}
export function validateFilters(input: Filters, scope?: string): Filters {
  const f = { ...input }
  for (const key of filterKeys) {
    f[key] = f[key].trim()
    if (['actor_id', 'client_id', 'resource_id'].includes(key))
      f[key] = f[key].toLowerCase()
    if (!f[key]) continue
    const schema = ['actor_id', 'client_id', 'resource_id'].includes(key)
      ? uuid
      : key === 'actor_kind'
        ? z.enum(['user', 'system'])
        : key === 'event_type'
          ? eventType
          : key === 'resource_kind'
            ? kind
            : key === 'request_id'
              ? requestID
              : timestamp
    if (!schema.safeParse(f[key]).success)
      throw new APIError(0, 'invalid_request')
  }
  if (
    (scope && f.client_id) ||
    (f.from && f.to && instant(f.from) >= instant(f.to))
  )
    throw new APIError(0, 'invalid_request')
  return f
}
export function matchesFilters(row: Summary, f: Filters) {
  return (
    (!f.actor_id || row.actor_user_id === f.actor_id) &&
    (!f.actor_kind || row.actor_kind === f.actor_kind) &&
    (!f.event_type || row.event_type === f.event_type) &&
    (!f.client_id || row.client_id === f.client_id) &&
    (!f.resource_kind || row.resource_kind === f.resource_kind) &&
    (!f.resource_id || row.resource_id === f.resource_id) &&
    (!f.request_id || row.request_id === f.request_id) &&
    (!f.from || instant(row.occurred_at) >= instant(f.from)) &&
    (!f.to || instant(row.occurred_at) < instant(f.to))
  )
}
export function sameSummary(a: Summary, b: Summary) {
  return (Object.keys(summaryShape) as (keyof Summary)[]).every(
    (key) => a[key] === b[key],
  )
}
