import { z } from '../../lib/validation'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { currencies, dateSchema, revisionSchema } from '../billing/models'
import { uuid, pagination } from '../operations/models'
const exact = z
  .string()
  .max(40)
  .regex(/^(0|[1-9]\d*)$/)
const signed = z
  .string()
  .max(40)
  .regex(/^(0|-?[1-9]\d*)$/)
const instant = z.string().datetime()
const currency = z.enum(currencies)
const nullableDate = dateSchema.nullable()
const status = z.enum([
  'pending',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
])
const service = z.enum([
  'software_maintenance',
  'software_development',
  'advertising_consulting',
  'other',
  'unclassified',
])
const position = z
  .object({
    amount_minor: exact,
    paid_minor: exact,
    outstanding_minor: exact,
    overdue_minor: exact,
    cancelled_amount_minor: exact,
    cancelled_paid_minor: exact,
    issued_minor: exact,
    count: exact,
    paid_count: exact,
    partial_count: exact,
    unpaid_count: exact,
    overdue_count: exact,
    cancelled_count: exact,
    debtor_count: exact,
    fully_paid_minor: exact,
    partial_outstanding_minor: exact,
    unpaid_minor: exact,
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.amount_minor) ===
        BigInt(v.paid_minor) + BigInt(v.outstanding_minor) &&
      BigInt(v.overdue_minor) <= BigInt(v.outstanding_minor),
  )
const activity = z
  .object({
    gross_minor: exact,
    reversed_minor: exact,
    net_minor: signed,
    roise_minor: signed,
    partner_minor: signed,
    unknown_minor: signed,
    payment_count: exact,
    reversal_count: exact,
    latest_date: nullableDate,
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.net_minor) ===
        BigInt(v.gross_minor) - BigInt(v.reversed_minor) &&
      BigInt(v.net_minor) ===
        BigInt(v.roise_minor) +
          BigInt(v.partner_minor) +
          BigInt(v.unknown_minor),
  )
const distribution = z
  .object({ label: z.string().max(40), amount_minor: signed, count: exact })
  .strict()
const metadata = {
  client_id: uuid.nullable(),
  as_of: instant,
  currency,
  from: dateSchema,
  to: dateSchema,
}
export const dashboardSchema = z
  .object({
    ...metadata,
    previous_from: dateSchema,
    previous_to: dateSchema,
    group: z.enum(['day', 'week', 'month', 'quarter', 'year']),
    position,
    alerts: z
      .array(
        z
          .object({
            rule: z.enum([
              'over_90',
              'undated',
              'concentration_50',
              'reversals_10',
              'unknown_collector',
              'partner_receivable',
              'partner_payable',
              'expenses_due_30',
            ]),
            amount_minor: signed,
            client_id: uuid.nullable(),
            name: z.string().max(200).nullable(),
            target: z.enum([
              'Receivables',
              'Clients',
              'Payments',
              'Partners',
              'Expenses',
            ]),
            tone: z.enum(['warning', 'neutral']),
          })
          .strict(),
      )
      .max(25),
    activity,
    previous: activity,
    prior_year: activity.nullable(),
    year_from: dateSchema,
    year_to: dateSchema,
    aging: z
      .array(
        z
          .object({
            bucket: z.enum([
              'undated',
              'future',
              'today',
              '1_7',
              '8_15',
              '16_30',
              '31_60',
              '61_90',
              'over_90',
            ]),
            amount_minor: exact,
            count: exact,
            clients: exact,
          })
          .strict(),
      )
      .max(9),
    upcoming: z
      .array(
        z
          .object({
            days: z.number().int().min(7).max(90),
            amount_minor: exact,
            count: exact,
          })
          .strict(),
      )
      .max(5),
    trends: z
      .array(
        z
          .object({
            period: z.string().max(10),
            cumulative_minor: signed,
            gross_minor: exact,
            reversed_minor: exact,
            net_minor: signed,
            count: exact,
          })
          .strict(),
      )
      .max(366),
    methods: z.array(distribution).max(4),
    collectors: z.array(distribution).max(3),
    services: z
      .array(
        z
          .object({
            label: service,
            activity_minor: signed,
            amount_minor: exact,
            paid_minor: exact,
            outstanding_minor: exact,
            count: exact,
          })
          .strict(),
      )
      .max(5),
    attention: z
      .array(
        z
          .object({
            id: uuid,
            client_id: uuid,
            client_name: z.string().max(200),
            description: z.string().max(2000),
            due_date: nullableDate,
            status,
            outstanding_minor: exact,
          })
          .strict(),
      )
      .max(10),
    concentration: z
      .array(
        z
          .object({
            client_id: uuid,
            client_name: z.string().max(200),
            net_minor: signed,
          })
          .strict(),
      )
      .max(10),
    partners: z
      .array(
        z
          .object({
            id: uuid,
            name: z.string().max(100),
            contracted_minor: exact,
            roise_share_minor: exact,
            partner_share_minor: exact,
            roise_recognized_minor: exact,
            partner_recognized_minor: exact,
            settled_minor: signed,
            receivable_minor: exact,
            payable_minor: exact,
            balance_minor: signed,
            count: exact,
          })
          .strict(),
      )
      .max(5000),
    expenses: z
      .object({
        position: z
          .object({
            recorded_minor: exact,
            outstanding_minor: exact,
            overdue_minor: exact,
            upcoming_minor: exact,
          })
          .strict(),
        activity: z
          .object({
            gross_minor: exact,
            reversed_minor: exact,
            net_minor: signed,
          })
          .strict(),
        trends: z
          .array(
            z.object({ period: z.string().max(7), net_minor: signed }).strict(),
          )
          .max(366),
        vendors: z
          .array(
            z
              .object({ label: z.string().max(200), amount_minor: signed })
              .strict(),
          )
          .max(100),
        categories: z
          .array(
            z
              .object({
                id: uuid,
                label: z.string().max(100),
                amount_minor: signed,
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .nullable(),
    positive_client_net_minor: exact,
    agreements: z
      .array(
        z
          .object({
            label: z.enum(['active', 'paused', 'cancelled', 'expired']),
            count: exact,
            potential_next_minor: exact,
          })
          .strict(),
      )
      .max(4),
    cashflow: z
      .array(
        z
          .object({
            period: z.string().regex(/^\d{4}-\d{2}$/),
            customer_minor: signed,
            incoming_minor: exact,
            outgoing_minor: exact,
            operating_minor: signed,
            net_minor: signed,
          })
          .strict(),
      )
      .max(366)
      .nullable(),
    settlements: z
      .object({ incoming_minor: exact, outgoing_minor: exact })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.aging.reduce((n, a) => n + BigInt(a.amount_minor), 0n) ===
      BigInt(v.position.outstanding_minor),
  )
export type Dashboard = z.infer<typeof dashboardSchema>
export interface Filters {
  currency: string
  from: string
  to: string
  group: string
  client_id: string
  service_type: string
  status: string
  method: string
  collector: string
  agreement_id: string
  partner_id: string
  due_from: string
  due_to: string
  q: string
}
const fields = [
  'currency',
  'from',
  'to',
  'group',
  'client_id',
  'service_type',
  'status',
  'method',
  'collector',
  'agreement_id',
  'partner_id',
  'due_from',
  'due_to',
  'q',
] as const
export function query(filters: Partial<Filters>, cursor = '') {
  const p = new URLSearchParams()
  for (const k of fields) {
    const v = filters[k]
    if (v && v !== 'all') p.set(k, v)
  }
  if (cursor) p.set('cursor', uuid.parse(cursor))
  return p.toString()
}
export function checked<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) throw new APIError(0, 'invalid_response')
  return result.data
}
export async function dashboard(filters: Filters, signal?: AbortSignal) {
  const v = checked(
    z.object({ data: dashboardSchema }).strict(),
    await authenticatedJSON(
      '/api/v1/finance/dashboard?' + query(filters),
      signal ? { signal } : {},
    ),
  ).data
  if (
    v.client_id !== (filters.client_id || null) ||
    v.currency !== filters.currency ||
    v.from !== filters.from ||
    v.to !== filters.to ||
    v.group !== filters.group
  )
    throw new APIError(0, 'invalid_response')
  return v
}
const receivable = z
  .object({
    id: uuid,
    client_id: uuid,
    client_name: z.string().max(200),
    description: z.string().max(2000),
    currency,
    service_type: service,
    agreement_id: uuid.nullable(),
    amount_minor: exact,
    paid_minor: exact,
    outstanding_minor: exact,
    due_date: nullableDate,
    status,
    billed_on: dateSchema,
  })
  .strict()
const payment = z
  .object({
    id: uuid,
    client_id: uuid,
    client_name: z.string().max(200),
    description: z.string().max(2000),
    collection_id: uuid,
    service_type: service,
    agreement_id: uuid.nullable(),
    amount_minor: exact,
    occurred_on: dateSchema,
    recorded_at: instant,
    method: z.enum(['bank_transfer', 'cash', 'card', 'other']),
    collector: z.enum(['roise', 'partner', 'unknown']),
    kind: z.enum(['payment', 'reversal']),
  })
  .strict()
const client = z
  .object({
    id: uuid,
    client_name: z.string().max(200),
    amount_minor: exact,
    paid_minor: exact,
    outstanding_minor: exact,
    overdue_minor: exact,
    count: exact,
    next_due: nullableDate,
    last_payment_on: nullableDate,
    activity_minor: signed,
  })
  .strict()
export type Receivable = z.infer<typeof receivable>
export type Payment = z.infer<typeof payment>
export type ClientPosition = z.infer<typeof client>
export type Report = 'receivables' | 'payments' | 'clients'
export async function details<R extends Report>(
  report: R,
  filters: Filters,
  cursor = '',
  signal?: AbortSignal,
) {
  const schema =
    report === 'receivables'
      ? receivable
      : report === 'payments'
        ? payment
        : client
  const result = checked(
    z
      .object({
        data: z
          .object({
            ...metadata,
            report: z.literal(report),
            data: z.array(schema).max(100),
            page: pagination,
          })
          .strict(),
      })
      .strict(),
    await authenticatedJSON(
      `/api/v1/finance/reports/${report}?${query(filters, cursor)}`,
      signal ? { signal } : {},
    ),
  ).data
  if (
    result.currency !== filters.currency ||
    result.from !== filters.from ||
    result.to !== filters.to
  )
    throw new APIError(0, 'invalid_response')
  if (result.client_id !== (filters.client_id || null))
    throw new APIError(0, 'invalid_response')
  ordered(result.data, result.page.next_cursor, cursor)
  if (
    filters.client_id &&
    result.data.some((r) =>
      'client_id' in r
        ? r.client_id !== filters.client_id
        : r.id !== filters.client_id,
    )
  )
    throw new APIError(0, 'invalid_response')
  return result as Omit<typeof result, 'data'> & {
    data: (R extends 'receivables'
      ? Receivable
      : R extends 'payments'
        ? Payment
        : ClientPosition)[]
  }
}
export type ExportReport =
  | Report
  | 'services'
  | 'partners'
  | 'aging'
  | 'cashflow'
  | 'expenses'
export async function exportPage(
  report: ExportReport,
  filters: Filters,
  cursor = '',
) {
  return checked(
    z
      .object({
        data: z
          .object({
            csv: z.string().max(524288),
            next_cursor: uuid.nullable(),
            as_of: instant,
            currency,
            report: z.literal(report),
          })
          .strict(),
      })
      .strict(),
    await authenticatedJSON(
      `/api/v1/finance/exports/${report}?${query(filters, cursor)}`,
    ),
  ).data
}
export const expenseSchema = z
  .object({
    id: uuid,
    client_id: uuid.nullable(),
    client_name: z.string().max(200).nullable(),
    category_id: uuid,
    category_name: z.string().max(100),
    title: z.string().max(200),
    vendor: z.string().max(200),
    description: z.string().max(4000),
    currency,
    amount_minor: revisionSchema,
    paid_minor: exact,
    outstanding_minor: exact,
    expense_date: dateSchema,
    due_date: nullableDate,
    cancelled_at: instant.nullable(),
    revision: revisionSchema,
    created_at: instant,
  })
  .strict()
  .refine(
    (v) =>
      BigInt(v.paid_minor) <= BigInt(v.amount_minor) &&
      BigInt(v.outstanding_minor) ===
        (v.cancelled_at ? 0n : BigInt(v.amount_minor) - BigInt(v.paid_minor)),
  )
export type Expense = z.infer<typeof expenseSchema>
const expenseEvent = z
  .object({
    id: uuid,
    expense_id: uuid,
    payment_id: uuid.nullable(),
    kind: z.enum(['payment', 'reversal']),
    amount_minor: revisionSchema,
    occurred_on: dateSchema,
    method: z.enum(['bank_transfer', 'cash', 'card', 'other']),
    reason: z.string().max(2000),
    recorded_at: instant,
    expected_revision: revisionSchema,
  })
  .strict()
export type ExpenseEvent = z.infer<typeof expenseEvent>
export async function expenses(
  currency: string,
  cursor = '',
  signal?: AbortSignal,
  client = '',
  filters: ExpenseFilters = { status: 'all', category_id: '', q: '' },
) {
  const result = checked(
    z
      .object({ data: z.array(expenseSchema).max(100), page: pagination })
      .strict(),
    await authenticatedJSON(
      '/api/v1/finance/expenses?' +
        new URLSearchParams({
          currency,
          ...(client ? { client_id: uuid.parse(client) } : {}),
          ...(filters.status !== 'all' ? { status: filters.status } : {}),
          ...(filters.category_id
            ? { category_id: uuid.parse(filters.category_id) }
            : {}),
          ...(filters.q ? { q: filters.q } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      signal ? { signal } : {},
    ),
  )
  ordered(result.data, result.page.next_cursor, cursor)
  if (
    result.data.some(
      (r) => r.currency !== currency || (client && r.client_id !== client),
    )
  )
    throw new APIError(0, 'invalid_response')
  return result
}
export async function categories(cursor = '', signal?: AbortSignal) {
  const result = checked(
    z
      .object({
        data: z
          .array(z.object({ id: uuid, name: z.string().max(100) }).strict())
          .max(100),
        page: pagination,
      })
      .strict(),
    await authenticatedJSON(
      '/api/v1/finance/expense-categories?' +
        new URLSearchParams({ ...(cursor ? { cursor } : {}) }),
      signal ? { signal } : {},
    ),
  )
  ordered(result.data, result.page.next_cursor, cursor)
  return result
}
export async function events(id: string, cursor = '', signal?: AbortSignal) {
  const result = checked(
    z
      .object({ data: z.array(expenseEvent).max(100), page: pagination })
      .strict(),
    await authenticatedJSON(
      `/api/v1/finance/expenses/${uuid.parse(id)}/events?` +
        new URLSearchParams(cursor ? { cursor } : {}),
      signal ? { signal } : {},
    ),
  )
  ordered(result.data, result.page.next_cursor, cursor)
  if (result.data.some((r) => r.expense_id !== id))
    throw new APIError(0, 'invalid_response')
  return result
}
export async function expense(id: string, signal?: AbortSignal) {
  const result = checked(
    z.object({ data: expenseSchema }).strict(),
    await authenticatedJSON(
      `/api/v1/finance/expenses/${uuid.parse(id)}`,
      signal ? { signal } : {},
    ),
  ).data
  if (result.id !== id) throw new APIError(0, 'invalid_response')
  return result
}
export async function addCategory(id: string, name: string) {
  return checked(
    z
      .object({ data: z.object({ id: uuid, replayed: z.boolean() }).strict() })
      .strict(),
    await authenticatedJSON('/api/v1/finance/expense-categories', {
      method: 'POST',
      body: { id, name },
    }),
  ).data
}
export async function mutateExpense(path: string, input: unknown) {
  const result = checked(
    z
      .object({
        data: z
          .object({
            expense: expenseSchema,
            event_id: uuid.nullable(),
            replayed: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    await authenticatedJSON('/api/v1/finance/expenses' + path, {
      method: 'POST',
      body: input,
    }),
  ).data
  if (path) {
    const match = /^\/([^/]+)\/(events|cancel)$/.exec(path)
    if (
      !match ||
      !uuid.safeParse(match[1]).success ||
      result.expense.id !== match[1]
    )
      throw new APIError(0, 'invalid_response')
  } else {
    const sent = z
      .object({
        currency,
        client_id: uuid.nullable(),
        amount_minor: revisionSchema,
      })
      .passthrough()
      .safeParse(input)
    if (
      !sent.success ||
      result.expense.currency !== sent.data.currency ||
      result.expense.client_id !== sent.data.client_id ||
      result.expense.amount_minor !== sent.data.amount_minor
    )
      throw new APIError(0, 'invalid_response')
  }
  return result
}

function ordered(rows: { id: string }[], next: string | null, cursor: string) {
  if (
    rows.some(
      (r, i) =>
        (cursor && r.id <= cursor) || (i > 0 && r.id <= rows[i - 1]!.id),
    ) ||
    (next !== null && next !== rows.at(-1)?.id)
  )
    throw new APIError(0, 'invalid_response')
}

export interface ExpenseFilters {
  status: string
  category_id: string
  q: string
}
export async function exportExpenses(
  currency: string,
  client: string,
  filters: ExpenseFilters,
  cursor: string,
) {
  const q = new URLSearchParams({
    currency,
    ...(client ? { client_id: uuid.parse(client) } : {}),
    ...(cursor ? { cursor: uuid.parse(cursor) } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.category_id
      ? { category_id: uuid.parse(filters.category_id) }
      : {}),
    ...(filters.q ? { q: filters.q } : {}),
  })
  return checked(
    z
      .object({
        data: z
          .object({
            csv: z.string().max(524288),
            next_cursor: uuid.nullable(),
            as_of: instant,
            currency: z.literal(currency),
            report: z.literal('expenses'),
          })
          .strict(),
      })
      .strict(),
    await authenticatedJSON('/api/v1/finance/exports/expenses?' + q),
  ).data
}
