// Reminder wall clocks belong to an explicit zone, independent of the device zone.
const wallPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/
const zonePattern = /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/
export function validZone(zone: string) {
  if (zone.length > 100 || !zonePattern.test(zone)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0)
    return true
  } catch {
    return false
  }
}
export function wallClock(value: string) {
  const match = wallPattern.exec(value)
  if (!match)
    throw new Error(
      'Enter a valid date and time, with up to six fractional digits.',
    )
  const [, year, month, day, hour, minute, second = '00', fraction = ''] = match
  const d = new Date(0)
  d.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
  d.setUTCHours(Number(hour), Number(minute), Number(second), 0)
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}`
  if (
    Number(year) < 1 ||
    Number(year) > 9999 ||
    d.toISOString().slice(0, 19) !== base
  )
    throw new Error('Enter a valid calendar date and time.')
  const tail = fraction.replace(/0+$/, '')
  return {
    local: base + (tail ? '.' + tail : ''),
    seconds: d.getTime(),
    fraction: tail,
  }
}
export function utcFromWall(local: string, offset: number) {
  if (!Number.isInteger(offset) || Math.abs(offset) >= 86400)
    throw new Error('Invalid offset.')
  const wall = wallClock(local),
    d = new Date(wall.seconds - offset * 1000)
  if (d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999)
    throw new Error('UTC year must be 0001–9999.')
  return (
    d.toISOString().slice(0, 19) +
    (wall.fraction ? '.' + wall.fraction : '') +
    'Z'
  )
}
export interface Occurrence {
  offset: number
  utc: string
}
export function occurrences(local: string, zone: string): Occurrence[] {
  const wall = wallClock(local)
  if (!validZone(zone))
    throw new Error(
      'Enter a named IANA timezone, such as Europe/Istanbul or UTC.',
    )
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  function zoned(ms: number) {
    const parts = Object.fromEntries(
      format.formatToParts(ms).map((p) => [p.type, p.value]),
    )
    return `${parts.year!.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
  }
  const offsets = new Set<number>()
  // Observe both sides of nearby transitions, including half-hour and date skips.
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall.seconds + hours * 3600000
    try {
      offsets.add((wallClock(zoned(probe)).seconds - probe) / 1000)
    } catch {
      /* Calendar boundary. */
    }
  }
  const result: Occurrence[] = []
  for (const offset of offsets) {
    try {
      const utc = utcFromWall(wall.local, offset)
      if (zoned(wall.seconds - offset * 1000) === wall.local.slice(0, 19))
        result.push({ offset, utc })
    } catch {
      /* UTC boundary. */
    }
  }
  return result.sort((a, b) => a.utc.localeCompare(b.utc))
}
export function offsetLabel(offset: number) {
  const n = Math.abs(offset),
    pad = (v: number) => String(v).padStart(2, '0')
  return `UTC${offset < 0 ? '−' : '+'}${pad(Math.floor(n / 3600))}:${pad(Math.floor((n % 3600) / 60))}${n % 60 ? ':' + pad(n % 60) : ''}`
}
