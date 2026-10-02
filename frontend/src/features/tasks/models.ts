import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { instant } from './time'

export const statuses = [
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
] as const
export const priorities = ['low', 'medium', 'high', 'urgent'] as const
export type TaskStatus = (typeof statuses)[number]
export const statusLabels: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
}
export const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['backlog', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'review', 'done', 'cancelled'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  review: ['in_progress', 'blocked', 'done', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['backlog', 'todo'],
}
const text = (max: number, required = false, multiline = false) =>
  z
    .string()
    .transform((v) => v.replaceAll('\r\n', '\n').trim())
    .refine(
      (v) =>
        [...v].length <= max &&
        (!required || v.length > 0) &&
        !/[\p{Cc}]/u.test(multiline ? v.replaceAll('\n', '') : v),
      `Use ${required ? '1–' : 'up to '}${max} characters${multiline ? '; only line breaks are supported.' : ' without control characters.'}`,
    )
const uuid = z
  .string()
  .refine(isUUID, 'Choose a valid assignee.')
  .transform((v) => v.toLowerCase())
const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).getUTCFullYear() >= 1 &&
      new Date(v).getUTCFullYear() <= 9999,
    'Enter a valid timestamp with timezone.',
  )
export const metadataSchema = z
  .object({
    title: text(200, true),
    description: text(8000, false, true),
    priority: z.enum(priorities),
    assignee_id: uuid.nullable(),
    start_at: timestamp.nullable(),
    due_at: timestamp.nullable(),
    tags: z
      .array(text(40, true).transform((v) => v.toLowerCase()))
      .max(20, 'Use up to 20 tags.')
      .refine((v) => new Set(v).size === v.length, 'Tags must be distinct after normalization.'),
  })
  .refine(
    (v) =>
      !v.start_at ||
      !v.due_at ||
      (Number.isFinite(Date.parse(v.start_at)) &&
        Number.isFinite(Date.parse(v.due_at)) &&
        instant(v.due_at) >= instant(v.start_at)),
    { path: ['due_at'], message: 'Due time must not precede start time.' },
  )
export type Metadata = z.infer<typeof metadataSchema>
export const emptyMetadata: Metadata = {
  title: '',
  description: '',
  priority: 'medium',
  assignee_id: null,
  start_at: null,
  due_at: null,
  tags: [],
}
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const summaryBase = z.object({
  id: uuid,
  client_id: uuid,
  created_by: uuid,
  assignee_id: uuid.nullable(),
  title: text(200, true),
  status: z.enum(statuses),
  priority: z.enum(priorities),
  start_at: timestamp.nullable(),
  due_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  cancelled_at: timestamp.nullable(),
  revision,
  tags: metadataSchema.shape.tags,
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: timestamp.nullable(),
})
function consistent(v: z.infer<typeof summaryBase>) {
  if (
    [
      v.created_at,
      v.updated_at,
      v.start_at,
      v.due_at,
      v.completed_at,
      v.cancelled_at,
      v.archived_at,
    ].some((t) => t !== null && !Number.isFinite(Date.parse(t)))
  )
    return false
  return (
    (v.status === 'done') === (v.completed_at !== null) &&
    (v.status === 'cancelled') === (v.cancelled_at !== null) &&
    (!v.start_at || !v.due_at || instant(v.due_at) >= instant(v.start_at)) &&
    instant(v.updated_at) >= instant(v.created_at) &&
    [v.completed_at, v.cancelled_at, v.archived_at].every(
      (t) => !t || instant(t) >= instant(v.created_at),
    )
  )
}
const summarySchema = summaryBase.refine(consistent)
const taskSchema = summaryBase.extend({ description: text(8000, false, true) }).refine(consistent)
export type Summary = z.infer<typeof summarySchema>
export type Task = z.infer<typeof taskSchema>
const candidateSchema = z.object({ id: uuid, display_name: text(100, true) })
export type Candidate = z.infer<typeof candidateSchema>
function pageSchema<T extends z.ZodType<{ id: string }>>(item: T) {
  return z
    .object({
      data: z.array(item).max(100),
      page: z.object({
        limit: z.number().int().min(1).max(100),
        next_cursor: uuid.nullable(),
      }),
    })
    .refine(
      (v) =>
        v.data.length <= v.page.limit &&
        new Set(v.data.map((i) => i.id)).size === v.data.length &&
        (!v.page.next_cursor ||
          (v.data.length === v.page.limit && v.page.next_cursor === v.data.at(-1)?.id)),
    )
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
export const parseTask = (body: unknown) => parse(z.object({ data: taskSchema }), body).data
export const parsePage = (body: unknown) => parse(pageSchema(summarySchema), body)
export const parseCandidates = (body: unknown) => parse(pageSchema(candidateSchema), body)
export const parseMutation = (body: unknown) =>
  parse(z.object({ data: z.object({ id: uuid, revision }) }), body).data
export interface Filter {
  q: string
  tag: string
  status: TaskStatus | 'all'
  priority: (typeof priorities)[number] | 'all'
  assignee: string
  archived: 'false' | 'true' | 'all'
  sort: 'id' | '-id'
}
export const defaultFilter: Filter = {
  q: '',
  tag: '',
  status: 'all',
  priority: 'all',
  assignee: '',
  archived: 'false',
  sort: 'id',
}
