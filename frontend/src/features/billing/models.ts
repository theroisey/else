import { z } from 'zod'
import { APIError } from '../../services/authenticated'
import { uuid } from '../reminders/models'
import { instant } from '../../lib/time'
import { exponents, maxInt64 } from './money'
export const currencies = ['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'KWD'] as const
export const states = [
  'pending',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
] as const
export const labels = {
  pending: 'Pending',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
}
export const methods = ['bank_transfer', 'cash', 'card', 'other'] as const
export const methodLabels = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
}
const currency = z.enum(currencies)
const unsigned = z
  .string()
  .max(1000)
  .regex(/^(0|[1-9]\d*)$/)
const bounded = unsigned.refine(
  (v) => /^(0|[1-9]\d*)$/.test(v) && v.length <= 19 && BigInt(v) <= maxInt64,
)
export const revisionSchema = bounded.refine((v) => v !== '0')
const positive = revisionSchema
const text = (max: number, required = false, multiline = false) =>
  z
    .string()
    .transform((v) => v.replaceAll('\r\n', '\n').trim())
    .refine(
      (v) =>
        [...v].length <= max &&
        (!required || !!v) &&
        !/[\p{Cc}]/u.test(multiline ? v.replaceAll('\n', '') : v),
      `Use ${required ? '1–' : 'up to '}${max} characters${multiline ? ' with line breaks only.' : ' without control characters.'}`,
    )
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z')
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      v.slice(0, 4) !== '0000' &&
      Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === v
    )
  }, 'Enter a real calendar date in years 0001–9999.')
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine((v) => {
    const d = new Date(v)
    return (
      Number.isFinite(d.getTime()) &&
      d.getUTCFullYear() > 0 &&
      d.getUTCFullYear() <= 9999 &&
      d.toISOString().slice(0, 19) === v.slice(0, 19)
    )
  })
export const profileSchema = z
  .object({
    description: text(2000, true, true),
    internal_note: text(8000, false, true),
    amount_minor: positive,
    currency,
    due_date: dateSchema.nullable(),
  })
  .strict()
export type Profile = z.infer<typeof profileSchema>
const collection = profileSchema
  .extend({
    id: uuid,
    client_id: uuid,
    created_by: uuid,
    currency_exponent: z.number().int(),
    paid_minor: bounded,
    outstanding_minor: bounded,
    status: z.enum(states),
    revision: revisionSchema,
    cancelled_at: timestamp.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .refine((v) => {
    try {
      return (
        v.currency_exponent === exponents[v.currency] &&
        BigInt(v.paid_minor) <= BigInt(v.amount_minor) &&
        (v.status === 'cancelled') === (v.cancelled_at !== null) &&
        v.outstanding_minor ===
          (v.status === 'cancelled'
            ? '0'
            : String(BigInt(v.amount_minor) - BigInt(v.paid_minor))) &&
        (v.status === 'paid') ===
          (v.status !== 'cancelled' && v.paid_minor === v.amount_minor) &&
        (v.status !== 'partially_paid' ||
          (BigInt(v.paid_minor) > 0n && BigInt(v.outstanding_minor) > 0n)) &&
        (v.status !== 'pending' || v.paid_minor === '0') &&
        instant(v.updated_at) >= instant(v.created_at) &&
        (!v.cancelled_at || instant(v.cancelled_at) >= instant(v.created_at))
      )
    } catch {
      return false
    }
  })
export type Collection = z.infer<typeof collection>
export const paymentSchema = z
  .object({
    command_id: uuid.refine(
      (v) => v !== '00000000-0000-0000-0000-000000000000',
    ),
    amount_minor: positive,
    currency,
    paid_on: dateSchema,
    method: z.enum(methods),
    reference: text(200),
    note: text(2000, false, true),
  })
  .strict()
export type PaymentInput = z.infer<typeof paymentSchema>
const payment = paymentSchema.extend({
  id: uuid,
  client_id: uuid,
  collection_id: uuid,
  recorded_by: uuid,
  collection_revision: revisionSchema,
  recorded_at: timestamp,
})
export type Payment = z.infer<typeof payment>
export const totalsSchema = z
  .object({
    currency,
    currency_exponent: z.number().int(),
    amount_minor: unsigned,
    paid_minor: unsigned,
    outstanding_minor: unsigned,
    overdue_minor: unsigned,
    cancelled_amount_minor: unsigned,
    cancelled_paid_minor: unsigned,
  })
  .strict()
  .refine((v) => {
    try {
      return (
        v.currency_exponent === exponents[v.currency] &&
        BigInt(v.amount_minor) ===
          BigInt(v.paid_minor) + BigInt(v.outstanding_minor) &&
        BigInt(v.overdue_minor) <= BigInt(v.outstanding_minor) &&
        BigInt(v.cancelled_paid_minor) <= BigInt(v.cancelled_amount_minor)
      )
    } catch {
      return false
    }
  })
export type Totals = z.infer<typeof totalsSchema>
function page<T extends z.ZodType<{ id: string }>>(item: T) {
  return z
    .object({
      data: z.array(item).max(25),
      page: z.object({ limit: z.literal(25), next_cursor: uuid.nullable() }),
    })
    .refine(
      (p) =>
        p.data.every((v, i) => !i || v.id > p.data[i - 1]!.id) &&
        (!p.page.next_cursor ||
          (p.data.length === 25 && p.page.next_cursor === p.data.at(-1)?.id)),
    )
}
function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const r = schema.safeParse(body)
  if (!r.success) throw new APIError(0, 'invalid_response')
  return r.data
}
export const parsePage = (body: unknown) => parse(page(collection), body)
export const parseCollection = (body: unknown) =>
  parse(z.object({ data: collection }), body).data
export const parsePayments = (body: unknown) => parse(page(payment), body)
export const parseSummary = (body: unknown) =>
  parse(
    z.object({
      data: z
        .array(totalsSchema)
        .max(6)
        .refine((v) => new Set(v.map((t) => t.currency)).size === v.length),
    }),
    body,
  ).data
export const parseCurrencies = (body: unknown) =>
  parse(
    z.object({
      data: z
        .array(
          z
            .object({ code: currency, exponent: z.number().int() })
            .refine((v) => v.exponent === exponents[v.code]),
        )
        .length(6)
        .refine((v) => new Set(v.map((t) => t.code)).size === 6),
    }),
    body,
  ).data
export const parseMutation = (body: unknown) =>
  parse(
    z.object({
      data: z.object({
        id: uuid,
        revision: revisionSchema,
        payment_id: uuid.nullable(),
        replayed: z.boolean(),
      }),
    }),
    body,
  ).data
export interface Filter {
  search: string
  status: (typeof states)[number] | 'all'
  currency: (typeof currencies)[number] | ''
}
export const defaultFilter: Filter = { search: '', status: 'all', currency: '' }
export const pagePath = (client: string, id?: string) =>
  `/app/clients/${client}/billing${id ? '/' + id : ''}`
