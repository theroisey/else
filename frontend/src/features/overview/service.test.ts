import { beforeEach, expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'
import { parseOverview } from './models'
import { read } from './service'
import {
  clientID,
  otherID,
  identity,
  overview,
  task,
  reminder,
  event,
  date,
  horizon,
} from './fixtures.test-data'
const fetcher = vi.fn()
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
  })
beforeEach(() => {
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
it('makes one bounded GET without parameters, forwards cancellation and preserves exact finance above int64', async () => {
  const v = overview()
  v.finance!.currencies[0] = {
    ...v.finance!.currencies[0]!,
    amount_minor: '18446744073709551739',
    paid_minor: '25',
    outstanding_minor: '18446744073709551714',
    overdue_minor: '18446744073709551714',
  }
  fetcher.mockResolvedValue(json(v))
  const controller = new AbortController()
  const signal = controller.signal
  const result = await read(clientID, identity.user.permissions, signal)
  expect(result.finance!.currencies[0]!.outstanding_minor).toBe(
    '18446744073709551714',
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/clients/${clientID}/overview`,
    expect.objectContaining({
      method: 'GET',
      signal: expect.anything(),
      cache: 'no-store',
    }),
  )
  controller.abort()
  expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true)
})
it.each(['missing client grant', 'foreign scope', 'invalid client'])(
  'refuses %s before any request',
  async (scenario) => {
    const grants =
      scenario === 'missing client grant'
        ? identity.user.permissions.filter(
            (g) => g.permission !== 'clients.view',
          )
        : scenario === 'foreign scope'
          ? identity.user.permissions.map((g) => ({ ...g, client_id: otherID }))
          : identity.user.permissions
    await expect(
      read(
        scenario === 'invalid client' ? 'invalid' : clientID,
        grants,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(APIError)
    expect(fetcher).not.toHaveBeenCalled()
  },
)
it('distinguishes omitted modules from authorized empty data and masks independently without count leaks', async () => {
  const v = overview()
  fetcher.mockResolvedValue(json(v))
  const root = identity.user.permissions.filter((g) =>
    ['clients.view', 'activity.view'].includes(g.permission),
  )
  v.activity = {
    items: [
      event(5, 'task'),
      event(4, 'task'),
      event(3, 'task'),
      event(2, 'task'),
      event(1, 'client'),
    ],
    has_more: true,
  }
  fetcher.mockResolvedValue(json(v))
  const result = await read(clientID, root, new AbortController().signal)
  expect(result.finance).toBeUndefined()
  expect(result.tasks).toBeUndefined()
  expect(result.reminders).toBeUndefined()
  expect(result.activity).toEqual({
    items: [event(1, 'client')],
    has_more: false,
  })
  delete v.finance
  delete v.tasks
  delete v.reminders
  delete v.activity
  fetcher.mockResolvedValue(json(v))
  expect(
    await read(
      clientID,
      identity.user.permissions,
      new AbortController().signal,
    ),
  ).toEqual(v)
})
it('accepts exact now and horizon microseconds without rounding bucket comparisons', () => {
  const v = overview()
  v.tasks = {
    overdue: { items: [task(1, date)], has_more: false },
    due_soon: {
      items: [task(2, '2026-10-02T12:00:00.123457Z'), task(3, horizon)],
      has_more: false,
    },
  }
  v.reminders = {
    due: { items: [reminder(1, date)], has_more: false },
    upcoming: { items: [reminder(2, horizon)], has_more: false },
  }
  expect(parseOverview({ data: v }, clientID)).toEqual(v)
  v.tasks.due_soon.items[0]!.due_at = date
  expect(() => parseOverview({ data: v }, clientID)).toThrow(APIError)
})
it('rejects malformed headers, wrong bindings and expanded private records before caching', () => {
  for (const change of [
    (v: ReturnType<typeof overview>) => {
      v.client.id = otherID
    },
    (v: ReturnType<typeof overview>) => {
      v.client.status = 'archived'
    },
    (v: ReturnType<typeof overview>) => {
      v.horizon_end = '2026-10-09T12:00:00.123455Z'
    },
    (v: ReturnType<typeof overview>) => {
      v.as_of = '2026-02-30T12:00:00Z'
    },
    (v: ReturnType<typeof overview>) => {
      Object.assign(v.client, { notes: 'Synthetic private profile' })
    },
    (v: ReturnType<typeof overview>) => {
      Object.assign(v.tasks!.overdue.items[0]!, {
        description: 'Synthetic private task',
      })
    },
    (v: ReturnType<typeof overview>) => {
      Object.assign(v.finance!.currencies[0]!, {
        internal_note: 'Synthetic private finance',
      })
    },
    (v: ReturnType<typeof overview>) => {
      Object.assign(v.activity!.items[0]!, { actor_id: otherID })
    },
    (v: ReturnType<typeof overview>) => {
      v.activity!.items[0]!.summary = 'Private event text'
    },
    (v: ReturnType<typeof overview>) => {
      v.activity!.items[0]!.client_id = otherID
    },
  ]) {
    const v = overview()
    change(v)
    expect(() => parseOverview({ data: v }, clientID)).toThrow(APIError)
  }
  expect(() => parseOverview({ data: overview(), total: 9 }, clientID)).toThrow(
    APIError,
  )
})
it('rejects oversized queues, fabricated more, duplicates, wrong deadline order and terminal tasks', () => {
  for (const change of [
    (v: ReturnType<typeof overview>) => {
      v.tasks!.overdue.items = Array.from({ length: 6 }, (_, i) => task(i + 1))
    },
    (v: ReturnType<typeof overview>) => {
      v.tasks!.overdue.has_more = true
    },
    (v: ReturnType<typeof overview>) => {
      v.tasks!.overdue.items = [task(), task()]
    },
    (v: ReturnType<typeof overview>) => {
      v.tasks!.overdue.items = [task(2), task(1)]
    },
    (v: ReturnType<typeof overview>) => {
      Object.assign(v.tasks!.overdue.items[0]!, { status: 'done' })
    },
    (v: ReturnType<typeof overview>) => {
      v.tasks!.due_soon.items[0]!.due_at = '2026-10-10T00:00:00Z'
    },
    (v: ReturnType<typeof overview>) => {
      v.reminders!.due.items = [reminder(2), reminder(1)]
    },
    (v: ReturnType<typeof overview>) => {
      v.reminders!.upcoming.items[0]!.timezone = 'Invalid/Timezone'
    },
    (v: ReturnType<typeof overview>) => {
      v.activity!.items = [event(1), event(2)]
    },
  ]) {
    const v = overview()
    change(v)
    expect(() => parseOverview({ data: v }, clientID)).toThrow(APIError)
  }
})
it('rejects inexact currency totals, incorrect scales, currency duplicates and mixed balances', () => {
  for (const delta of [
    { amount_minor: 1000 },
    { amount_minor: '1e3' },
    { amount_minor: '01000' },
    { outstanding_minor: '900' },
    { overdue_minor: '751' },
    { cancelled_paid_minor: '201' },
    { currency_exponent: 3 },
  ]) {
    const v = overview()
    Object.assign(v.finance!.currencies[0]!, delta)
    expect(() => parseOverview({ data: v }, clientID)).toThrow(APIError)
  }
  const v = overview()
  v.finance!.currencies.push({ ...v.finance!.currencies[0]! })
  expect(() => parseOverview({ data: v }, clientID)).toThrow(APIError)
})
it('registers only the exact new profile return route', () => {
  expect(safeReturnTo(`/app/clients/${clientID}/profile`)).toBe(
    `/app/clients/${clientID}/profile`,
  )
  for (const path of ['profile/edit', 'profile?secret=1', 'profile/..'])
    expect(safeReturnTo(`/app/clients/${clientID}/${path}`)).toBe('/app')
})
