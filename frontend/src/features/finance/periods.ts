export function periodRange(preset: string, now = new Date()) {
  const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ),
    end = new Date(day),
    start = new Date(day),
    year = day.getUTCFullYear(),
    month = day.getUTCMonth(),
    weekday = (day.getUTCDay() + 6) % 7
  switch (preset) {
    case 'Yesterday':
      start.setUTCDate(start.getUTCDate() - 1)
      end.setTime(start.getTime())
      break
    case 'This week':
      start.setUTCDate(start.getUTCDate() - weekday)
      break
    case 'Last week':
      end.setUTCDate(end.getUTCDate() - weekday - 1)
      start.setTime(end.getTime())
      start.setUTCDate(start.getUTCDate() - 6)
      break
    case 'This month':
      start.setUTCDate(1)
      break
    case 'Last month':
      start.setUTCMonth(month - 1, 1)
      end.setUTCDate(0)
      break
    case 'Last 30 days':
      start.setUTCDate(start.getUTCDate() - 29)
      break
    case 'Last 90 days':
      start.setUTCDate(start.getUTCDate() - 89)
      break
    case 'This quarter':
      start.setUTCMonth(Math.floor(month / 3) * 3, 1)
      break
    case 'Last quarter':
      start.setUTCMonth(Math.floor(month / 3) * 3 - 3, 1)
      end.setUTCMonth(Math.floor(month / 3) * 3, 0)
      break
    case 'This year':
      start.setUTCMonth(0, 1)
      break
    case 'Last year':
      start.setUTCFullYear(year - 1, 0, 1)
      end.setUTCFullYear(year - 1, 11, 31)
      break
    case 'All time':
      return { from: '0001-01-01', to: day.toISOString().slice(0, 10) }
  }
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  }
}
