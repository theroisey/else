import { z } from '../../lib/validation'
import { isUUID } from '../auth/session'
export { canListClients, canOpenClients } from '../auth/permissions'

const text = (max: number, required = false) =>
  z
    .string()
    .trim()
    .refine(
      (v) =>
        [...v].length <= max &&
        (!required || v.length > 0) &&
        !/[\p{Cc}]/u.test(v),
      `Use ${required ? '1–' : 'up to '}${max} characters without control characters.`,
    )
const email = text(254)
  .transform((v) => v.toLowerCase())
  .refine(
    (v) =>
      !v ||
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        v,
      ),
    'Enter a valid email address.',
  )
export const contactSchema = z.object({
  name: text(100, true),
  email,
  phone: text(40),
})
export const profileSchema = z.object({
  name: text(200, true),
  legal_name: text(200),
  website: text(2048).refine((v) => {
    if (!v) return true
    try {
      const u = new URL(v)
      return (
        /^https?:\/\//i.test(v) &&
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        !!u.hostname &&
        !u.username &&
        !u.password &&
        !v.includes('#')
      )
    } catch {
      return false
    }
  }, 'Use an HTTP or HTTPS website without credentials or a fragment.'),
  notes: text(4000),
  contacts: z.array(contactSchema).max(20, 'Use up to 20 contacts.'),
  tags: z
    .array(text(40, true).transform((v) => v.toLowerCase()))
    .max(20, 'Use up to 20 tags.')
    .refine(
      (v) => new Set(v).size === v.length,
      'Tags must be distinct after normalization.',
    ),
})
export type Profile = z.infer<typeof profileSchema>
export const emptyProfile: Profile = {
  name: '',
  legal_name: '',
  website: '',
  notes: '',
  contacts: [],
  tags: [],
}
const uuid = z.string().refine(isUUID)
const timestamp = z.string().refine((v) => Number.isFinite(Date.parse(v)))
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const summarySchema = z
  .object({
    id: uuid,
    name: text(200, true),
    legal_name: text(200),
    status: z.enum(['active', 'archived']),
    revision,
    tags: profileSchema.shape.tags,
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: timestamp.nullable(),
  })
  .refine((v) => (v.status === 'archived') === (v.archived_at !== null))
const clientSchema = summarySchema.and(
  z.object({
    // Historical values are safe displayed text, not links or new URL input.
    // Preserve them for the reviewed website backfill even when malformed.
    website: z
      .string()
      .refine((value) => [...value].length <= 2048 && !/[\p{Cc}]/u.test(value)),
    notes: text(4000),
    contacts: z.array(contactSchema).max(20),
  }),
)
export type Summary = z.infer<typeof summarySchema>
export type Client = z.infer<typeof clientSchema>
export interface Filter {
  q: string
  tag: string
  status: 'active' | 'archived' | 'all'
  sort: 'id' | '-id'
}
export const defaultFilter: Filter = {
  q: '',
  tag: '',
  status: 'active',
  sort: 'id',
}
export function parseClient(body: unknown): Client {
  const result = z.object({ data: clientSchema }).safeParse(body)
  if (!result.success) throw new Error('Invalid client response.')
  return result.data.data
}
export function parsePage(body: unknown) {
  const result = z
    .object({
      data: z.array(summarySchema).max(100),
      page: z.object({
        limit: z.number().int().min(1).max(100),
        next_cursor: uuid.nullable(),
      }),
    })
    .safeParse(body)
  if (
    !result.success ||
    result.data.data.length > result.data.page.limit ||
    new Set(result.data.data.map((v) => v.id)).size !== result.data.data.length
  )
    throw new Error('Invalid client response.')
  return result.data
}
export function parseMutation(body: unknown) {
  const result = z
    .object({ data: z.object({ id: uuid, revision }) })
    .safeParse(body)
  if (!result.success) throw new Error('Invalid client response.')
  return result.data.data
}
