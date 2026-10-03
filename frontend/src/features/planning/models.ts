import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { instant } from '../../lib/time'
export const planStates = ['draft', 'active', 'completed', 'cancelled'] as const
export const milestoneStates = ['planned', 'in_progress', 'completed', 'cancelled'] as const
export type State = (typeof planStates)[number] | (typeof milestoneStates)[number]
export const labels: Record<State, string> = {
  draft: 'Draft',
  active: 'Active',
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}
export const planTransitions: Record<(typeof planStates)[number], readonly State[]> = {
  draft: ['active', 'cancelled'],
  active: ['draft', 'completed', 'cancelled'],
  completed: ['active'],
  cancelled: ['draft', 'active'],
}
export const milestoneTransitions: Record<(typeof milestoneStates)[number], readonly State[]> = {
  planned: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['planned', 'completed', 'cancelled'],
  completed: ['in_progress'],
  cancelled: ['planned', 'in_progress'],
}
export const terminal = (state?: string) => state === 'completed' || state === 'cancelled'
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
  .refine(isUUID)
  .transform((v) => v.toLowerCase())
const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).getUTCFullYear() >= 1 &&
      new Date(v).getUTCFullYear() <= 9999,
  )
export const metadataSchema = z
  .object({
    title: text(200, true),
    description: text(8000, false, true),
    start_at: timestamp.nullable(),
    due_at: timestamp.nullable(),
  })
  .refine((v) => !v.start_at || !v.due_at || instant(v.due_at) >= instant(v.start_at), {
    path: ['due_at'],
    message: 'Due time must not precede start time.',
  })
export type Metadata = z.infer<typeof metadataSchema>
export const emptyMetadata: Metadata = { title: '', description: '', start_at: null, due_at: null }
export const linkSetSchema = z
  .array(uuid)
  .max(50, 'Select up to 50 tasks.')
  .refine((v) => new Set(v).size === v.length, 'Task references must be distinct.')
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const summaryBase = z.object({
  id: uuid,
  client_id: uuid,
  plan_id: uuid.optional(),
  created_by: uuid,
  title: text(200, true),
  status: z.enum(['draft', 'active', 'planned', 'in_progress', 'completed', 'cancelled']),
  start_at: timestamp.nullable(),
  due_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  cancelled_at: timestamp.nullable(),
  revision,
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: timestamp.nullable(),
})
function consistent(v: z.infer<typeof summaryBase>) {
  return (
    (v.plan_id ? milestoneStates : planStates).some((s) => s === v.status) &&
    (!v.plan_id || v.start_at === null) &&
    (v.status === 'completed') === (v.completed_at !== null) &&
    (v.status === 'cancelled') === (v.cancelled_at !== null) &&
    (!v.start_at || !v.due_at || instant(v.due_at) >= instant(v.start_at)) &&
    instant(v.updated_at) >= instant(v.created_at) &&
    [v.completed_at, v.cancelled_at, v.archived_at].every(
      (t) => !t || instant(t) >= instant(v.created_at),
    )
  )
}
const summarySchema = summaryBase.refine(consistent)
const recordSchema = summaryBase
  .extend({ description: text(8000, false, true), task_ids: linkSetSchema.optional() })
  .refine(
    (v) => consistent(v) && (v.plan_id ? Array.isArray(v.task_ids) : v.task_ids === undefined),
  )
export type Summary = z.infer<typeof summarySchema>
export type RecordData = z.infer<typeof recordSchema>
const candidateSchema = z
  .object({
    id: uuid,
    title: text(200, true),
    status: z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled']),
  })
  .strict()
export type Candidate = z.infer<typeof candidateSchema>
const linkSchema = z
  .object({ id: uuid, task_id: uuid, linked_at: timestamp, unlinked_at: timestamp.nullable() })
  .strict()
  .refine((v) => !v.unlinked_at || instant(v.unlinked_at) >= instant(v.linked_at))
export type TaskLink = z.infer<typeof linkSchema>
function pageSchema<T extends z.ZodType<{ id: string }>>(item: T) {
  return z
    .object({
      data: z.array(item).max(100),
      page: z.object({ limit: z.number().int().min(1).max(100), next_cursor: uuid.nullable() }),
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
  const r = schema.safeParse(body)
  if (!r.success) throw new APIError(0, 'invalid_response')
  return r.data
}
export const parseRecord = (body: unknown) => parse(z.object({ data: recordSchema }), body).data
export const parsePage = (body: unknown) => parse(pageSchema(summarySchema), body)
export const parseCandidates = (body: unknown) => parse(pageSchema(candidateSchema), body)
export const parseLinks = (body: unknown) => parse(pageSchema(linkSchema), body)
export const parseMutation = (body: unknown) =>
  parse(z.object({ data: z.object({ id: uuid, revision }) }), body).data
export interface Scope {
  clientID: string
  planID?: string
}
export interface Filter {
  q: string
  status: State | 'all'
  archived: 'false' | 'true' | 'all'
  sort: 'id' | '-id'
}
export const defaultFilter: Filter = { q: '', status: 'all', archived: 'false', sort: 'id' }
export function pagePath(scope: Scope, id?: string) {
  return `/app/clients/${scope.clientID}/plans${scope.planID ? '/' + scope.planID + '/milestones' : ''}${id ? '/' + id : ''}`
}
export const recordKey = (scope: Scope, id: string) => ['detail', scope.planID ?? '', id]
