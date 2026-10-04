import { z } from '../../lib/validation'

export const reportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01'
})
export interface DatePeriod { since: string; until: string }
export function validDatePeriod(p: DatePeriod) {
  return reportDate.safeParse(p.since).success && reportDate.safeParse(p.until).success && p.until >= p.since &&
    Date.parse(p.until) - Date.parse(p.since) <= 30 * 86400000
}
