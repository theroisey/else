import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
export const uuid = z.string().refine(isUUID)
export const exact = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(39)
const instant = z.string().datetime()
const safeURL = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true
    try {
      const u = new URL(value)
      return (
        ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      )
    } catch {
      return false
    }
  })
export const states = [
  'new',
  'accepted',
  'rejected',
  'in_progress',
  'delivered',
  'revision_requested',
  'approved',
  'cancelled',
] as const
export const labels: Record<(typeof states)[number], string> = {
  new: 'New',
  accepted: 'Accepted',
  rejected: 'Rejected',
  in_progress: 'In progress',
  delivered: 'Awaiting review',
  revision_requested: 'Revision requested',
  approved: 'Approved',
  cancelled: 'Cancelled',
}
export const eventLabels: Record<string, string> = {
  created: 'Request created',
  accepted: 'Request accepted',
  rejected: 'Request rejected',
  assigned: 'Developer assigned',
  started: 'Work started',
  delivered: 'Delivery submitted',
  approved: 'Delivery approved',
  revision_requested: 'Revision requested',
  reopened: 'Request reopened',
  cancelled: 'Request cancelled',
  commented: 'Comment added',
}
export const actionLabels: Record<string, string> = {
  accept: 'Accept request',
  reject: 'Reject request',
  assign: 'Assign developer',
  start: 'Start work',
  deliver: 'Submit delivery',
  approve: 'Approve delivery',
  revise: 'Request revision',
  reopen: 'Reopen request',
  cancel: 'Cancel request',
  comment: 'Add comment',
}
export const summary = z
  .object({
    id: uuid,
    client_id: uuid,
    website_id: uuid.nullable(),
    created_by: uuid,
    title: z.string().min(1).max(200),
    category: z.enum([
      'bug',
      'design',
      'feature',
      'content',
      'performance',
      'integration',
      'support',
      'other',
    ]),
    priority: z.enum(['normal', 'high', 'critical']),
    status: z.enum(states),
    assignee_id: uuid.nullable(),
    task_id: uuid.nullable(),
    due_at: instant.nullable(),
    revision: exact,
    delivery_count: z.number().int().nonnegative(),
    created_at: instant,
    updated_at: instant,
    brand_name: z.string().max(200),
    website_name: z.string().max(200).nullable(),
    website_domain: z.string().max(253).nullable(),
    requester_name: z.string().max(100),
    assignee_name: z.string().max(100).nullable(),
  })
  .strict()
const delivery = z
  .object({
    id: uuid,
    request_id: uuid,
    number: z.number().int().positive(),
    delivered_by: uuid,
    developer_name: z.string().max(100),
    summary: z.string().min(1).max(8000),
    test_notes: z.string().max(4000),
    implementation_url: safeURL,
    reference: z.string().max(300),
    created_at: instant,
  })
  .strict()
const review = z
  .object({
    id: uuid,
    delivery_id: uuid,
    reviewed_by: uuid,
    reviewer_name: z.string().max(100),
    decision: z.enum(['approved', 'revision_requested']),
    reason: z.string().max(8000),
    created_at: instant,
  })
  .strict()
const evidence = z
  .object({
    id: uuid,
    client_id: uuid,
    request_id: uuid,
    delivery_id: uuid.nullable(),
    filename: z.string().max(120),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
    size: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
    created_at: instant,
  })
  .strict()
export const detailSchema = summary
  .extend({
    description: z.string().min(1).max(8000),
    reference_url: safeURL,
    deliveries: z.array(delivery).max(25),
    reviews: z.array(review).max(25),
    evidence: z.array(evidence).max(32),
    actions: z
      .array(
        z.enum([
          'accept',
          'reject',
          'assign',
          'start',
          'deliver',
          'approve',
          'revise',
          'reopen',
          'cancel',
          'comment',
        ]),
      )
      .max(10),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.actions).size === v.actions.length &&
      v.deliveries.every((d) => d.request_id === v.id) &&
      v.reviews.every((r) =>
        v.deliveries.some((d) => d.id === r.delivery_id),
      ) &&
      v.evidence.every(
        (e) => e.request_id === v.id && e.client_id === v.client_id,
      ),
  )
export type RequestDetail = z.infer<typeof detailSchema>
export type RequestSummary = z.infer<typeof summary>
export const pagination = z
  .object({
    limit: z.number().int().min(1).max(100),
    next_cursor: uuid.nullable(),
  })
  .strict()
export const pageSchema = z
  .object({ data: z.array(summary).max(100), page: pagination })
  .strict()
const queue = <T>(item: z.ZodType<T>, max: number) =>
  z.object({ items: z.array(item).max(max), has_more: z.boolean() }).strict()
export const todaySchema = z
  .object({
    as_of: instant,
    horizon_end: instant,
    timezone: z.string().max(80),
    request_counts: z
      .object(
        Object.fromEntries(states.map((s) => [s, exact])) as Record<
          (typeof states)[number],
          typeof exact
        >,
      )
      .strict(),
    overdue_tasks: exact,
    requests: queue(
      z
        .object({
          id: uuid,
          client_id: uuid,
          title: z.string().max(200),
          status: z.enum(states),
          priority: z.enum(['normal', 'high', 'critical']),
          due_at: instant.nullable(),
          brand_name: z.string().max(200),
          requester_name: z.string().max(100),
        })
        .strict(),
      10,
    ),
    tasks: queue(
      z
        .object({
          id: uuid,
          client_id: uuid,
          title: z.string().max(200),
          status: z.string().max(30),
          due_at: instant.nullable(),
          brand_name: z.string().max(200),
          assignee_name: z.string().max(100).nullable(),
        })
        .strict(),
      10,
    ),
    reminders: queue(
      z
        .object({
          id: uuid,
          client_id: uuid,
          title: z.string().max(200),
          scheduled_at: instant,
          timezone: z.string().max(80),
          brand_name: z.string().max(200),
        })
        .strict(),
      10,
    ),
    brands: queue(
      z
        .object({
          id: uuid,
          name: z.string().max(200),
          websites: exact,
        })
        .strict(),
      12,
    ),
    team_members: exact.optional(),
    internal_finance: z
      .array(
        z
          .object({
            currency: z.enum(['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'KWD']),
            receivable_minor: exact,
            payable_minor: exact,
          })
          .strict(),
      )
      .max(6)
      .optional(),
    finance: z
      .array(
        z
          .object({
            currency: z.enum(['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'KWD']),
            outstanding_minor: exact,
            overdue_minor: exact,
          })
          .refine((v) => BigInt(v.overdue_minor) <= BigInt(v.outstanding_minor))
          .strict(),
      )
      .max(6)
      .optional(),
  })
  .strict()
export const notificationSchema = z
  .object({
    id: uuid,
    client_id: uuid.nullable(),
    request_id: uuid.nullable(),
    task_id: uuid.nullable(),
    period_id: uuid.nullable().optional().default(null),
    agreement_id: uuid.nullable().optional().default(null),
    template_id: uuid.nullable().optional().default(null),
    kind: z.string().min(1).max(64),
    created_at: instant,
    read_at: instant.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.client_id !== null &&
      [
        v.request_id,
        v.task_id,
        v.period_id,
        v.agreement_id,
        v.template_id,
      ].filter((v) => v !== null).length === 1,
  )
export const inboxSchema = z
  .object({
    data: z.array(notificationSchema).max(100),
    page: z
      .object({
        limit: z.number().int().min(1).max(100),
        next_cursor: z.string().max(256).nullable(),
      })
      .strict(),
    unread_count: exact,
  })
  .strict()
export const timelineSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: uuid,
            request_id: uuid,
            sequence: exact,
            actor_id: uuid,
            actor_name: z.string().max(100),
            action: z.enum([
              'created',
              'accepted',
              'rejected',
              'assigned',
              'started',
              'delivered',
              'approved',
              'revision_requested',
              'reopened',
              'cancelled',
              'commented',
            ]),
            status: z.enum(states),
            text: z.string().max(8000),
            delivery_id: uuid.nullable(),
            created_at: instant,
          })
          .strict(),
      )
      .max(100),
    page: z
      .object({
        limit: z.number().int().min(1).max(100),
        next_after: exact.nullable(),
      })
      .strict(),
  })
  .strict()
export const mutationSchema = z
  .object({
    id: uuid,
    revision: exact,
    status: z.enum(states),
    replayed: z.boolean(),
  })
  .strict()
export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
export function data<T>(schema: z.ZodType<T>, value: unknown): T {
  return checked(z.object({ data: schema }).strict(), value).data
}

export const deliveryPageSchema = z
  .object({
    data: z.array(delivery).max(25),
    reviews: z.array(review).max(25),
    page: z
      .object({ limit: z.literal(25), next_before: exact.nullable() })
      .strict(),
  })
  .strict()
