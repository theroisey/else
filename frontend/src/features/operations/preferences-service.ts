import { z } from '../../lib/validation'
import { authenticatedJSON } from '../../services/authenticated'
import { exact, data } from './models'
export const preferencesSchema = z
  .object({
    workflow: z.boolean(),
    tasks: z.boolean(),
    finance: z.boolean(),
    revision: exact,
  })
  .strict()
export const settingsSchema = z
  .object({ timezone: z.string().min(1).max(100), revision: exact })
  .strict()
export async function businessSettings(signal: AbortSignal) {
  return data(
    settingsSchema,
    await authenticatedJSON('/api/v1/operations-settings', { signal }),
  )
}
export function localDate(timezone: string, tomorrow = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const take = (kind: string) => parts.find((v) => v.type === kind)!.value
  const day = `${take('year')}-${take('month')}-${take('day')}`
  if (!tomorrow) return day
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}
