import { automationFailure } from './automation-models'
import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { uuid, exact, pagination, checked, data } from './models'
import {
  currencies,
  dateSchema,
  revisionSchema,
  parseMutation,
} from '../billing/models'
const instant = z.string().datetime()
const currency = z.enum(currencies)
const signed = z
  .string()
  .max(40)
  .regex(/^(0|-?[1-9][0-9]*)$/)
export const terms = z
  .object({
    amount_minor: revisionSchema,
    currency,
    roise_share_minor: exact,
    partner_id: uuid.nullable(),
    collector: z.enum(['roise', 'partner']),
    allocation_policy: z.enum(['proportional', 'contractual']),
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.roise_share_minor) <= BigInt(v.amount_minor) &&
      (!!v.partner_id ||
        (v.roise_share_minor === v.amount_minor && v.collector === 'roise')),
  )
export const agreement = z
  .object({
    latest_terms: terms,
    latest_effective_from: dateSchema,
    id: uuid,
    client_id: uuid,
    created_by: uuid,
    managed_by: uuid,
    manager_name: z.string().max(100),
    automation_failure: automationFailure,
    title: z.string().min(1).max(200),
    service_type: z.enum([
      'software_maintenance',
      'software_development',
      'advertising_consulting',
      'other',
    ]),
    frequency: z.enum(['once', 'monthly']),
    start_date: dateSchema,
    end_date: dateSchema.nullable(),
    due_offset_days: z.number().int().min(0).max(90),
    timezone: z.string().max(100),
    anchor_day: z.number().int().min(1).max(31),
    next_date: dateSchema,
    status: z.enum(['active', 'paused', 'cancelled', 'expired']),
    revision: revisionSchema,
    created_at: instant,
    updated_at: instant,
  })
  .strict()
export type Agreement = z.infer<typeof agreement>
export const version = terms
  .safeExtend({
    id: uuid,
    agreement_id: uuid,
    client_id: uuid,
    number: revisionSchema,
    partner_name: z.string().max(100).nullable(),
    effective_from: dateSchema,
    created_at: instant,
  })
  .strict()
export const period = z
  .object({
    id: uuid,
    client_id: uuid,
    agreement_id: uuid,
    version_id: uuid,
    collection_id: uuid,
    currency,
    period_key: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),
    billing_date: dateSchema,
    voided_at: instant.nullable(),
    voided_by: uuid.nullable(),
    void_reason: z.string().max(2000),
    title: z.string().max(200),
    partner_id: uuid.nullable(),
    partner_name: z.string().max(100).nullable(),
    collector: z.enum(['roise', 'partner']),
    allocation_policy: z.enum(['proportional', 'contractual']),
    collection_revision: revisionSchema,
    due_date: dateSchema.nullable(),
    settlement_revision: revisionSchema,
    amount_minor: revisionSchema,
    paid_minor: exact,
    roise_share_minor: exact,
    outstanding_minor: exact,
    partner_share_minor: exact,
    roise_recognized_minor: exact,
    partner_recognized_minor: exact,
    internal_due_to_roise_minor: signed,
    settled_to_roise_minor: signed,
    internal_remaining_to_roise_minor: signed,
  })
  .strict()
  .refine(
    (v) =>
      (v.voided_at
        ? v.paid_minor === '0' && v.outstanding_minor === '0'
        : BigInt(v.paid_minor) + BigInt(v.outstanding_minor) ===
          BigInt(v.amount_minor)) &&
      BigInt(v.roise_share_minor) + BigInt(v.partner_share_minor) ===
        BigInt(v.amount_minor) &&
      BigInt(v.internal_due_to_roise_minor) -
        BigInt(v.settled_to_roise_minor) ===
        BigInt(v.internal_remaining_to_roise_minor),
  )
export type Period = z.infer<typeof period>
export const settlement = z
  .object({
    id: uuid,
    period_id: uuid,
    client_id: uuid,
    currency,
    direction: z.enum(['partner_to_roise', 'roise_to_partner']),
    amount_minor: revisionSchema,
    settled_on: dateSchema,
    reference: z.string().max(200),
    note: z.string().max(2000),
    recorded_by: uuid,
    recorded_at: instant,
  })
  .strict()
export const reversal = z
  .object({
    id: uuid,
    payment_id: uuid,
    collection_id: uuid,
    client_id: uuid,
    currency,
    recorded_by: uuid,
    amount_minor: revisionSchema,
    reversed_on: dateSchema,
    reason: z.string().max(2000),
    command_id: uuid,
    collection_revision: revisionSchema,
    recorded_at: instant,
  })
  .strict()
const receipt = z.object({ id: uuid, replayed: z.boolean() }).strict()
function base(client: string) {
  if (!uuid.safeParse(client).success) throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}`
}
function identifier(id: string) {
  if (!uuid.safeParse(id).success) throw new APIError(0, 'invalid_request')
  return id
}
async function page<T extends { id: string }>(
  path: string,
  schema: z.ZodType<T>,
  cursor: string,
  signal: AbortSignal,
  bind: (v: T) => boolean,
  filters: Record<string, string> = {},
) {
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', identifier(cursor))
  for (const [key, value] of Object.entries(filters))
    if (value) q.set(key, value)
  const v = checked(
    z.object({ data: z.array(schema).max(25), page: pagination }).strict(),
    await authenticatedJSON(`${path}?${q}`, { signal }),
  )
  if (
    v.data.some(
      (r, i) =>
        !bind(r) ||
        (cursor && r.id <= cursor) ||
        (i > 0 && r.id <= v.data[i - 1]!.id),
    ) ||
    (v.page.next_cursor !== null && v.page.next_cursor !== v.data.at(-1)?.id)
  )
    throw new APIError(0, 'invalid_response')
  return v
}
export const agreements = (
  client: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client)}/agreements`,
    agreement,
    cursor,
    signal,
    (v) => v.client_id === client,
  )
export interface PeriodFilters {
  q: string
  service_type: string
  currency: string
  collector: string
  payment_collector?: string
  partner_id: string
  payment_status: string
  from: string
  to: string
}
const periodFiltersInput = z
  .object({
    q: z.string().max(100),
    service_type: z.enum([
      '',
      'software_maintenance',
      'software_development',
      'advertising_consulting',
      'other',
    ]),
    currency: z.union([currency, z.literal('')]),
    collector: z.enum(['', 'roise', 'partner']),
    payment_collector: z.enum(['', 'roise', 'partner']).default(''),
    partner_id: z.union([uuid, z.literal(''), z.literal('none')]),
    payment_status: z.enum([
      '',
      'pending',
      'partially_paid',
      'paid',
      'overdue',
      'cancelled',
    ]),
    from: z.union([dateSchema, z.literal('')]),
    to: z.union([dateSchema, z.literal('')]),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to)
export const periods = async (
  client: string,
  id: string | null,
  cursor: string,
  signal: AbortSignal,
  filters?: PeriodFilters,
) => {
  const checkedFilters = filters ? periodFiltersInput.safeParse(filters) : null
  if (checkedFilters && !checkedFilters.success)
    throw new APIError(0, 'invalid_request')
  return page(
    id
      ? `${base(client)}/agreements/${identifier(id)}/periods`
      : `${base(client)}/commercial-periods`,
    period,
    cursor,
    signal,
    (v) => v.client_id === client && (!id || v.agreement_id === id),
    checkedFilters?.success ? { ...checkedFilters.data } : {},
  )
}
export const versions = (
  client: string,
  id: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client)}/agreements/${identifier(id)}/versions`,
    version,
    cursor,
    signal,
    (v) => v.client_id === client && v.agreement_id === id,
  )
export const partners = (client: string, cursor: string, signal: AbortSignal) =>
  page(
    `${base(client)}/agreements/partners`,
    z
      .object({
        id: uuid,
        name: z.string().max(100),
        archived_at: instant.nullable(),
      })
      .strict(),
    cursor,
    signal,
    () => true,
  )
export const settlements = (
  client: string,
  id: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client)}/commercial-periods/${identifier(id)}/settlements`,
    settlement,
    cursor,
    signal,
    (v) => v.client_id === client && v.period_id === id,
  )
export const reversals = (
  client: string,
  id: string,
  cursor: string,
  signal: AbortSignal,
) =>
  page(
    `${base(client)}/billing/${identifier(id)}/reversals`,
    reversal,
    cursor,
    signal,
    (v) => v.client_id === client && v.collection_id === id,
  )
export async function readPeriod(
  client: string,
  id: string,
  signal: AbortSignal,
) {
  const v = data(
    period,
    await authenticatedJSON(
      `${base(client)}/commercial-periods/${identifier(id)}`,
      { signal },
    ),
  )
  if (v.id !== id || v.client_id !== client)
    throw new APIError(0, 'invalid_response')
  return v
}
export async function write(
  client: string,
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
) {
  return data(
    receipt,
    await authenticatedJSON(`${base(client)}/${path}`, { method, body }),
  )
}

export async function paymentMutation(
  client: string,
  collection: string,
  path: string,
  body: unknown,
) {
  const raw = await authenticatedJSON(
    `${base(client)}/billing/${identifier(collection)}/${path}`,
    { method: 'POST', body },
  )
  if (path.endsWith('/reverse')) {
    const v = data(
      z
        .object({
          id: uuid,
          revision: revisionSchema,
          reversal_id: uuid,
          replayed: z.boolean(),
        })
        .strict(),
      raw,
    )
    if (v.id !== collection) throw new APIError(0, 'invalid_response')
    return v
  }
  const v = parseMutation(raw)
  if (v.id !== collection || !v.payment_id)
    throw new APIError(0, 'invalid_response')
  return v
}
