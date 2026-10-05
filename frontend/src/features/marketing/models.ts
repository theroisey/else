import { formatCurrency } from '../../i18n/format'
import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { reportDate, validDatePeriod } from '../integrations/date-period'
import type { DatePeriod } from '../integrations/date-period'
import {
  parseReportCatalog,
  reportTimestamp,
  syncStatus,
} from '../integrations/report-contracts'
export { validDatePeriod as validPeriod } from '../integrations/date-period'
export { parseQueued } from '../integrations/report-contracts'
export type { DatePeriod as Period } from '../integrations/date-period'

const uuid = z.string().refine(isUUID)
const count = (digits: number) =>
  z.string().regex(new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})$`))
const spend = (digits: number) =>
  z
    .string()
    .regex(new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{0,5}[1-9])?$`))
const ratio = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,22})\.[0-9]{6}$/)
  .nullable()
const metricFields = (digits: number) => ({
  spend_decimal: spend(digits),
  impressions: count(digits),
  clicks: count(digits),
  ctr_percent: ratio,
  cpc_decimal: ratio,
  cpm_decimal: ratio,
})
const metrics = z.object(metricFields(20)).strict()
const day = z.object({ date: reportDate, ...metricFields(18) }).strict()
const collected = reportTimestamp.refine(
  (v) => v >= '2000-01-01T00:00:00Z' && !/\.\d*0Z$/.test(v),
)
const workspace = z
  .object({
    report: z
      .object({
        client_id: uuid,
        connection_id: uuid,
        graph_version: z.literal('v26.0'),
        currency: z.string().regex(/^[A-Z]{3}$/),
        timezone: z
          .string()
          .min(1)
          .max(128)
          .refine((v) => {
            try {
              new Intl.DateTimeFormat('en', { timeZone: v })
              return v !== 'Local'
            } catch {
              return false
            }
          }),
        since: reportDate,
        until: reportDate,
        days: z.array(day).max(31),
        totals: metrics,
        attribution_status: z.literal('unavailable'),
      })
      .strict(),
    collected_from: collected,
    collected_through: collected,
  })
  .strict()
const view = z
  .object({ status: syncStatus, data: workspace.nullable() })
  .strict()
export type View = z.infer<typeof view>
export type Workspace = z.infer<typeof workspace>
export type Metrics = z.infer<typeof metrics>

export function spendUnits(value: string) {
  const [whole = '', fraction = ''] = value.split('.')
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
function rounded(
  numerator: bigint,
  denominator: bigint,
  multiplier: bigint,
): string | null {
  if (denominator === 0n) return null
  const scaled = numerator * multiplier
  const q =
    scaled / denominator +
    ((scaled % denominator) * 2n >= denominator ? 1n : 0n)
  return `${q / 1000000n}.${(q % 1000000n).toString().padStart(6, '0')}`
}
function validMetrics(value: Metrics) {
  const s = spendUnits(value.spend_decimal),
    i = BigInt(value.impressions),
    c = BigInt(value.clicks)
  return (
    value.ctr_percent === rounded(c * 1000000n, i, 100n) &&
    value.cpc_decimal === rounded(s, c, 1n) &&
    value.cpm_decimal === rounded(s, i, 1000n)
  )
}
function micros(value: string) {
  return (
    BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1000n +
    BigInt((value.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0'))
  )
}
export function parseView(
  body: unknown,
  client: string,
  connection: string,
  period: DatePeriod,
): View {
  const parsed = view.safeParse(body)
  const invalid = () => {
    throw new APIError(0, 'invalid_response')
  }
  if (!parsed.success || !validDatePeriod(period)) return invalid()
  const result = parsed.data,
    w = result.data
  if (!w) {
    if (result.status.synced_at !== null || !result.status.stale)
      return invalid()
    return result
  }
  const r = w.report
  if (
    !result.status.synced_at ||
    r.client_id !== client ||
    r.connection_id !== connection ||
    r.since !== period.since ||
    r.until !== period.until ||
    micros(w.collected_through) < micros(w.collected_from) ||
    micros(w.collected_through) - micros(w.collected_from) > 121000000n ||
    !validMetrics(r.totals)
  )
    return invalid()
  let s = 0n,
    i = 0n,
    c = 0n,
    previous = ''
  for (const day of r.days) {
    if (
      day.date <= previous ||
      day.date < period.since ||
      day.date > period.until ||
      !validMetrics(day)
    )
      return invalid()
    previous = day.date
    s += spendUnits(day.spend_decimal)
    i += BigInt(day.impressions)
    c += BigInt(day.clicks)
  }
  if (
    spendUnits(r.totals.spend_decimal) !== s ||
    BigInt(r.totals.impressions) !== i ||
    BigInt(r.totals.clicks) !== c
  )
    return invalid()
  return result
}
export function parseCatalog(body: unknown, client: string, after = '') {
  return parseReportCatalog(body, client, 'meta_ads', after)
}
export function validToken(value: string) {
  return (
    value.length >= 16 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9._~+/-]+={0,2}$/.test(value)
  )
}
export function amount(decimal: string, currency: string) {
  return formatCurrency(decimal, currency, decimal.split('.')[1]?.length ?? 0)
}
