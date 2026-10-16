import { currentLocale } from './locale.ts'

// Cache only public formatting configuration, never formatted business values.
// Bound uncommon currencies/timezones/options so a long session cannot grow it.
function cache<T>() {
  const entries = new Map<string, T>()
  return (options: object, create: () => T) => {
    const key =
      currentLocale() +
      JSON.stringify(
        Object.entries(options).sort(([a], [b]) => a.localeCompare(b)),
      )
    const existing = entries.get(key)
    if (existing) return existing
    const formatter = create()
    if (entries.size >= 64) entries.delete(entries.keys().next().value!)
    entries.set(key, formatter)
    return formatter
  }
}
const numbers = cache<Intl.NumberFormat>()
const dates = cache<Intl.DateTimeFormat>()
const relative = cache<Intl.RelativeTimeFormat>()
export const numberFormatter = (options: Intl.NumberFormatOptions = {}) =>
  numbers(options, () => new Intl.NumberFormat(currentLocale(), options))
export const dateFormatter = (options: Intl.DateTimeFormatOptions = {}) =>
  // A device's default timezone can change while the application is open.
  // Only explicitly bound timezones are safe to retain across calls.
  options.timeZone
    ? dates(options, () => new Intl.DateTimeFormat(currentLocale(), options))
    : new Intl.DateTimeFormat(currentLocale(), options)
export const relativeFormatter = () =>
  relative(
    {},
    () => new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' }),
  )
