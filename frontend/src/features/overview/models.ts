import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { instant } from '../../lib/time'
import { isUUID } from '../auth/session'
import { totalsSchema } from '../billing/models'
import { activityEventSchema } from '../activity/models'
import { priorities, statuses } from '../tasks/models'

const uuid = z.string().refine(isUUID)
const utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((v) => {
    const date = new Date(v)
    return (
      Number.isFinite(date.getTime()) &&
      date.getUTCFullYear() >= 1 &&
      date.toISOString().slice(0, 19) === v.slice(0, 19)
    )
  })
const title = z
  .string()
  .min(1)
  .refine((v) => [...v].length <= 200 && v.trim() === v && !/[\p{Cc}]/u.test(v))
const task = z
  .object({
    id: uuid,
    title,
    status: z.enum(statuses).refine((s) => s !== 'done' && s !== 'cancelled'),
    priority: z.enum(priorities),
    due_at: utc,
  })
  .strict()
const reminder = z
  .object({
    id: uuid,
    title,
    scheduled_at: utc,
    timezone: z
      .string()
      .max(100)
      .regex(/^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: v })
          return true
        } catch {
          return false
        }
      }),
  })
  .strict()
function queue<T extends z.ZodType<{ id: string }>>(item: T) {
  return z
    .object({ items: z.array(item).max(5), has_more: z.boolean() })
    .strict()
    .refine(
      (q) =>
        new Set(q.items.map((v) => v.id)).size === q.items.length &&
        (!q.has_more || q.items.length === 5),
    )
}
const schema = z
  .object({
    data: z
      .object({
        client: z
          .object({
            id: uuid,
            name: title,
            status: z.enum(['active', 'archived']),
            archived_at: utc.nullable(),
          })
          .strict()
          .refine(
            (c) => (c.status === 'archived') === (c.archived_at !== null),
          ),
        as_of: utc,
        horizon_end: utc,
        finance: z
          .object({
            currencies: z
              .array(totalsSchema)
              .max(6)
              .refine((rows) =>
                rows.every((v, i) => !i || v.currency > rows[i - 1]!.currency),
              ),
          })
          .strict()
          .optional(),
        tasks: z
          .object({ overdue: queue(task), due_soon: queue(task) })
          .strict()
          .optional(),
        reminders: z
          .object({ due: queue(reminder), upcoming: queue(reminder) })
          .strict()
          .optional(),
        activity: queue(activityEventSchema).optional(),
      })
      .strict(),
  })
  .strict()
export type Overview = z.infer<typeof schema>['data']
export type DueTask = z.infer<typeof task>
export type DueReminder = z.infer<typeof reminder>
export type Queue<T> = { items: T[]; has_more: boolean }

export function parseOverview(body: unknown, client: string): Overview {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new APIError(0, 'invalid_response')
  const v = parsed.data.data
  const invalid = () => {
    throw new APIError(0, 'invalid_response')
  }
  if (
    v.client.id !== client ||
    instant(v.horizon_end) - instant(v.as_of) !== 604800000000n
  )
    invalid()
  function deadlines<T extends { id: string }>(
    rows: T[],
    stamp: (row: T) => string,
    future: boolean,
  ) {
    return rows.every((row, i) => {
      const time = instant(stamp(row)),
        previous = i ? rows[i - 1]! : null
      return (
        (future
          ? time > instant(v.as_of) && time <= instant(v.horizon_end)
          : time <= instant(v.as_of)) &&
        (!previous ||
          time > instant(stamp(previous)) ||
          (time === instant(stamp(previous)) && row.id > previous.id))
      )
    })
  }
  if (v.tasks) {
    const due = (row: DueTask) => row.due_at
    const all = [...v.tasks.overdue.items, ...v.tasks.due_soon.items]
    if (
      new Set(all.map((t) => t.id)).size !== all.length ||
      !deadlines(v.tasks.overdue.items, due, false) ||
      !deadlines(v.tasks.due_soon.items, due, true)
    )
      invalid()
  }
  if (v.reminders) {
    const due = (row: DueReminder) => row.scheduled_at
    const all = [...v.reminders.due.items, ...v.reminders.upcoming.items]
    if (
      new Set(all.map((t) => t.id)).size !== all.length ||
      !deadlines(v.reminders.due.items, due, false) ||
      !deadlines(v.reminders.upcoming.items, due, true)
    )
      invalid()
  }
  if (
    v.activity?.items.some(
      (row, i, rows) =>
        row.client_id !== client ||
        (i > 0 &&
          (instant(row.occurred_at) > instant(rows[i - 1]!.occurred_at) ||
            (instant(row.occurred_at) === instant(rows[i - 1]!.occurred_at) &&
              row.id >= rows[i - 1]!.id))),
    )
  )
    invalid()
  return v
}
