import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { parseReportCatalog, syncStatus } from '../integrations/report-contracts'
export { parseQueued } from '../integrations/report-contracts'

const uuid = z.string().refine(isUUID)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01'
})
export const metricNames = ['activeUsers', 'sessions', 'screenPageViews', 'keyEvents'] as const
const safeText = (max: number, multiline = false) => z.string().max(max).refine(v => new TextEncoder().encode(v).length <= max && !/[\p{Cc}\uFFFD]/u.test(multiline ? v.replaceAll('\n', '').replaceAll('\t', '') : v))
const integer = /^(0|[1-9][0-9]{0,17})$/
const decimal = /^(0|[1-9][0-9]{0,17})(\.[0-9]{0,17}[1-9])?$/
const definition = z.object({
  name: z.enum(metricNames), type: z.enum(['TYPE_INTEGER', 'TYPE_FLOAT']),
  display_name: safeText(256).min(1), description: safeText(4096, true).min(1),
}).strict()
const report = z.object({
  client_id: uuid, connection_id: uuid, api_version: z.literal('v1beta'),
  timezone: z.string().min(1).max(256).refine(v => {
    try { new Intl.DateTimeFormat('en', { timeZone: v }); return v !== 'Local' } catch { return false }
  }),
  since: date, until: date, dimensions: z.array(z.string()).max(2),
  metrics: z.array(z.string()).length(4),
  rows: z.array(z.object({ dimensions: z.array(safeText(1024)).max(2), metrics: z.array(z.string().max(37)).length(4) }).strict()).max(1000),
}).strict()
const workspace = z.object({
  definitions: z.array(definition).length(4), summary: report, daily: report,
  acquisition: report, devices: report, landing: report,
}).strict()
const view = z.object({ status: syncStatus, data: workspace.nullable() }).strict()
export type Workspace = z.infer<typeof workspace>
export type Report = z.infer<typeof report>
export type View = z.infer<typeof view>
export interface Period { since: string; until: string }
export function validPeriod(p: Period) {
  return date.safeParse(p.since).success && date.safeParse(p.until).success && p.until >= p.since &&
    Date.parse(p.until) - Date.parse(p.since) <= 30 * 86400000
}
export function parseView(body: unknown, client: string, connection: string, period: Period): View {
  const parsed = view.safeParse(body)
  if (!parsed.success || !validPeriod(period)) throw new APIError(0, 'invalid_response')
  const result = parsed.data
  const w = result.data
  if (!w) {
    if (result.status.synced_at !== null || !result.status.stale) throw new APIError(0, 'invalid_response')
    return result
  }
  if (!result.status.synced_at || w.definitions.some((v, i) => v.name !== metricNames[i] || i < 3 && v.type !== 'TYPE_INTEGER'))
    throw new APIError(0, 'invalid_response')
  const templates: [Report, string[]][] = [[w.summary, []], [w.daily, ['date']], [w.acquisition, ['date', 'sessionDefaultChannelGroup']], [w.devices, ['date', 'deviceCategory']], [w.landing, ['landingPage']]]
  for (const [r, dimensions] of templates) {
    if (r.client_id !== client || r.connection_id !== connection || r.since !== period.since || r.until !== period.until ||
      r.timezone !== w.summary.timezone || JSON.stringify(r.dimensions) !== JSON.stringify(dimensions) ||
      JSON.stringify(r.metrics) !== JSON.stringify(metricNames) || !dimensions.length && r.rows.length > 1)
      throw new APIError(0, 'invalid_response')
    let previous: string[] | undefined
    for (const row of r.rows) {
      if (row.dimensions.length !== dimensions.length || row.metrics.some((v, i) => !(w.definitions[i]!.type === 'TYPE_INTEGER' ? integer : decimal).test(v)) ||
        row.dimensions.some(v => v.startsWith('RESERVED_'))) throw new APIError(0, 'invalid_response')
      if (dimensions[0] === 'date') {
        const value = row.dimensions[0]!
        const day = value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8)
        if (!/^\d{8}$/.test(value) || !date.safeParse(day).success || day < period.since || day > period.until ||
          dimensions.length === 2 && !(row.dimensions[1]!.length > 0 && row.dimensions[1]!.length <= 256)) throw new APIError(0, 'invalid_response')
      }
      if (dimensions[0] === 'landingPage' && row.dimensions[0] !== '(not set)' &&
        (!row.dimensions[0]!.startsWith('/') || row.dimensions[0]!.startsWith('//') || /[?#@\\]/.test(row.dimensions[0]!))) throw new APIError(0, 'invalid_response')
      // Match Go's UTF-8 tuple order (locale collation varies by browser).
      if (previous && compareTuple(previous, row.dimensions) >= 0) throw new APIError(0, 'invalid_response')
      previous = row.dimensions
    }
  }
  return result
}
function compareTuple(a: string[], b: string[]) {
  for (let i = 0; i < a.length; i++) {
    const x = Array.from(a[i]!, c => c.codePointAt(0)!), y = Array.from(b[i]!, c => c.codePointAt(0)!)
    for (let j = 0; j < Math.min(x.length, y.length); j++) if (x[j] !== y[j]) return x[j]! - y[j]!
    if (x.length !== y.length) return x.length - y.length
  }
  return 0
}
export function parseCatalog(body: unknown, client: string, after = '') {
  return parseReportCatalog(body, client, 'ga4', after)
}
