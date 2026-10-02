import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { instant } from '../../lib/time'
import { isUUID } from '../auth/session'

export const eventTypes = [
  'client.created',
  'client.updated',
  'client.archived',
  'task.created',
  'task.updated',
  'task.archived',
  'task.completed',
  'task.cancelled',
  'plan.created',
  'plan.updated',
  'plan.archived',
  'milestone.created',
  'milestone.updated',
  'milestone.archived',
  'reminder.created',
  'reminder.updated',
  'reminder.completed',
  'reminder.dismissed',
] as const
export const kindLabels = {
  client: 'Client',
  task: 'Task',
  plan: 'Plan',
  milestone: 'Milestone',
  reminder: 'Reminder',
} as const
const uuid = z
  .string()
  .refine(isUUID)
  .transform((v) => v.toLowerCase())
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
export const cursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
const event = z
  .object({
    id: uuid,
    client_id: uuid,
    occurred_at: timestamp,
    event_type: z.enum(eventTypes),
    resource_kind: z.enum(['client', 'task', 'plan', 'milestone', 'reminder']),
    resource_id: uuid,
    summary: z.string().max(40),
  })
  .strict()
  .refine((v) => {
    const [kind, action] = v.event_type.split('.')
    return (
      kind === v.resource_kind &&
      v.summary === `${kindLabels[v.resource_kind]} ${action}.` &&
      (v.resource_kind !== 'client' || v.resource_id === v.client_id)
    )
  })
export type ActivityEvent = z.infer<typeof event>
export const activityEventSchema = event
const page = z
  .object({
    data: z.array(event).max(25),
    page: z.object({ limit: z.literal(25), next_cursor: cursorSchema.nullable() }).strict(),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.data.map((v) => v.id)).size === p.data.length &&
      (!p.page.next_cursor || p.data.length === 25) &&
      p.data.every((v, i) => {
        if (!i) return true
        const previous = p.data[i - 1]!
        try {
          return (
            instant(previous.occurred_at) > instant(v.occurred_at) ||
            (instant(previous.occurred_at) === instant(v.occurred_at) && previous.id > v.id)
          )
        } catch {
          return false
        }
      }),
  )
export function parsePage(body: unknown) {
  const result = page.safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
