import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { exponents } from '../billing/money'
import { parseReportCatalog, reportTimestamp, syncStatus } from '../integrations/report-contracts'
export { parseQueued } from '../integrations/report-contracts'
export { money } from '../billing/money'

export const currencies = ['USD', 'EUR', 'GBP', 'TRY', 'JPY', 'KWD'] as const
export type Currency = typeof currencies[number]
const exponent = (currency: Currency) => exponents[currency]
const uuid = z.string().refine(isUUID)
const integer = (digits: number) => z.string().max(digits).regex(/^(0|[1-9][0-9]*)$/)
const id = z.string().regex(/^[1-9][0-9]{0,17}$/)
const productID = integer(18)
const utcSecond = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(v => {
  const date = new Date(v)
  return Number.isFinite(date.getTime()) && v >= '2000-01-01T00:00:00Z' && date.toISOString() === v.replace('Z', '.000Z')
})
export interface Period { start: string; end: string; currency: Currency }
export function validPeriod(period: Period) {
  return utcSecond.safeParse(period.start).success && utcSecond.safeParse(period.end).success &&
    currencies.includes(period.currency) && period.end > period.start && Date.parse(period.end) - Date.parse(period.start) <= 31 * 86400000
}
const binding = {
  client_id: uuid, connection_id: uuid, api_version: z.literal('wc/v3'), currency: z.enum(currencies),
  currency_exponent: z.number().int().min(0).max(3), start: utcSecond, end: utcSecond,
}
const order = z.object({
  id, status: z.enum(['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash']),
  created_at: utcSecond, grand_total_minor: integer(18), lifetime_refund_minor: integer(20), remainder_minor: integer(18),
}).strict()
const refund = z.object({ id, parent_id: id, created_at: utcSecond, amount_minor: integer(18) }).strict()
const product = z.object({
  product_id: productID, variation_id: productID, quantity: integer(23), order_count: integer(3), line_count: integer(5),
  total_minor: integer(23), tax_minor: integer(23), line_grand_minor: integer(23),
}).strict()
const collectedTime = reportTimestamp.refine(v => v >= '2000-01-01T00:00:00Z' && (!v.includes('.') || !v.endsWith('0Z')))
const workspace = z.object({
  orders: z.object({ ...binding, orders: z.array(order).max(500), grand_total_minor: integer(21), lifetime_refund_minor: integer(21), remainder_minor: integer(21) }).strict(),
  refunds: z.object({ ...binding, refunds: z.array(refund).max(500), amount_minor: integer(21) }).strict(),
  products: z.object({ ...binding, products: z.array(product).max(1000) }).strict(),
  collected_from: collectedTime, collected_through: collectedTime,
}).strict()
const view = z.object({ status: syncStatus, data: workspace.nullable() }).strict()
export type Workspace = z.infer<typeof workspace>
export type View = z.infer<typeof view>
export type Order = z.infer<typeof order>
export type Refund = z.infer<typeof refund>
export type Product = z.infer<typeof product>

function microseconds(value: string) {
  return BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1000n + BigInt((value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0'))
}
function invalid(): never { throw new APIError(0, 'invalid_response') }
export function parseView(body: unknown, client: string, connection: string, period: Period): View {
  const parsed = view.safeParse(body)
  if (!parsed.success || !validPeriod(period)) invalid()
  const result = parsed.data
  const w = result.data
  if (!w) {
    if (result.status.synced_at !== null || !result.status.stale) invalid()
    return result
  }
  if (!result.status.synced_at || microseconds(w.collected_through) < microseconds(w.collected_from) ||
    microseconds(w.collected_through) - microseconds(w.collected_from) > 121000000n) invalid()
  for (const report of [w.orders, w.refunds, w.products]) {
    if (report.client_id !== client || report.connection_id !== connection || report.start !== period.start || report.end !== period.end ||
      report.currency !== period.currency || report.currency_exponent !== exponent(period.currency)) invalid()
  }
  let grand = 0n, lifetime = 0n, remaining = 0n, refunded = 0n, previous = 0n, totalLines = 0n
  const orderIDs = new Set<string>()
  for (const row of w.orders.orders) {
    if (BigInt(row.id) <= previous || row.created_at < period.start || row.created_at >= period.end ||
      BigInt(row.grand_total_minor) !== BigInt(row.lifetime_refund_minor) + BigInt(row.remainder_minor)) invalid()
    previous = BigInt(row.id); orderIDs.add(row.id)
    grand += BigInt(row.grand_total_minor); lifetime += BigInt(row.lifetime_refund_minor); remaining += BigInt(row.remainder_minor)
  }
  if (grand.toString() !== w.orders.grand_total_minor || lifetime.toString() !== w.orders.lifetime_refund_minor || remaining.toString() !== w.orders.remainder_minor) invalid()
  previous = 0n
  for (const row of w.refunds.refunds) {
    if (BigInt(row.id) <= previous || row.id === row.parent_id || orderIDs.has(row.id) || row.created_at < period.start || row.created_at >= period.end) invalid()
    previous = BigInt(row.id); refunded += BigInt(row.amount_minor)
  }
  if (refunded.toString() !== w.refunds.amount_minor) invalid()
  let previousProduct: Product | undefined
  for (const row of w.products.products) {
    const quantity = BigInt(row.quantity), orders = BigInt(row.order_count), lines = BigInt(row.line_count)
    if (previousProduct && (BigInt(row.product_id) < BigInt(previousProduct.product_id) || row.product_id === previousProduct.product_id && BigInt(row.variation_id) <= BigInt(previousProduct.variation_id)) ||
      orders < 1n || orders > BigInt(w.orders.orders.length) || lines < orders || lines > orders * 50n || quantity < lines ||
      quantity > lines * 999999999999999999n || BigInt(row.total_minor) > lines * 999999999999999999n || BigInt(row.tax_minor) > lines * 999999999999999999n ||
      BigInt(row.line_grand_minor) !== BigInt(row.total_minor) + BigInt(row.tax_minor)) invalid()
    totalLines += lines; previousProduct = row
  }
  if (totalLines > BigInt(w.orders.orders.length) * 50n) invalid()
  return result
}
export function parseCatalog(body: unknown, client: string, after = '') { return parseReportCatalog(body, client, 'woocommerce', after) }

export function dailyObservations(w: Workspace) {
  const days = new Map<string, { day: string; orderGrand: bigint | null; refundAmount: bigint | null }>()
  for (const order of w.orders.orders) {
    const day = order.created_at.slice(0, 10), row = days.get(day) ?? { day, orderGrand: null, refundAmount: null }
    row.orderGrand = (row.orderGrand ?? 0n) + BigInt(order.grand_total_minor); days.set(day, row)
  }
  for (const refund of w.refunds.refunds) {
    const day = refund.created_at.slice(0, 10), row = days.get(day) ?? { day, orderGrand: null, refundAmount: null }
    row.refundAmount = (row.refundAmount ?? 0n) + BigInt(refund.amount_minor); days.set(day, row)
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}
