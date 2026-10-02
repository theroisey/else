import { beforeEach, expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'
import { taskPermissions } from '../tasks/permissions'
import { planningPermissions } from '../planning/permissions'
import { reminderPermissions } from '../reminders/permissions'
import { activityPermissions } from './permissions'
import { eventTypes, parsePage } from './models'
import { event, page, clientID, identity, otherID } from './fixtures.test-data'
import * as api from './service'
const fetcher = vi.fn()
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})

it.each(eventTypes)('accepts only the static %s projection', (type) => {
  const row = event(1, type)
  expect(parsePage(page([row])).data).toEqual([row])
  for (const delta of [
    { summary: 'Private entered text' },
    { resource_kind: 'other' },
    { actor_id: otherID },
    { metadata: { title: 'Private' } },
  ])
    expect(() => parsePage(page([{ ...row, ...delta }]))).toThrow(APIError)
})
it('requires both client/activity grants and each independent current domain view', () => {
  const grants = identity.user.permissions
  const root = grants.filter((g) => ['clients.view', 'activity.view'].includes(g.permission))
  expect(activityPermissions(root, clientID).allows(event(1, 'client.created'))).toBe(true)
  for (const type of [
    'task.created',
    'plan.created',
    'milestone.created',
    'reminder.created',
  ] as const)
    expect(activityPermissions(root, clientID).allows(event(1, type))).toBe(false)
  expect(activityPermissions(grants, otherID).view).toBe(false)
  expect(
    activityPermissions(
      grants.filter((g) => g.permission !== 'clients.view'),
      clientID,
    ).view,
  ).toBe(false)
  expect(
    activityPermissions(
      grants.filter((g) => g.permission !== 'activity.view'),
      clientID,
    ).view,
  ).toBe(false)
  expect(
    activityPermissions(
      [
        { permission: 'activity.view', scope: 'global' },
        { permission: 'clients.view', scope: 'global' },
      ],
      clientID,
    ).view,
  ).toBe(true)
  expect(activityPermissions(grants, clientID).allows({ ...event(), client_id: otherID })).toBe(
    false,
  )
  for (const permissions of [taskPermissions, planningPermissions, reminderPermissions]) {
    expect(permissions(grants, clientID).activityView).toBe(true)
    expect(
      permissions(
        grants.filter((g) => g.permission !== 'clients.view'),
        clientID,
      ).activityView,
    ).toBe(false)
  }
})
it('allows only the validated activity return destination', () => {
  const path = `/app/clients/${clientID}/activity`
  expect(safeReturnTo(path)).toBe(path)
  for (const invalid of [
    path + '/new',
    path + '/edit',
    path + '?cursor=private',
    path + '/..',
    '/app/clients/invalid/activity',
    '//external.test/activity',
  ])
    expect(safeReturnTo(invalid)).toBe('/app')
})
it('rejects invalid dates, unreviewed events and expanded successful envelopes', () => {
  for (const delta of [
    { occurred_at: '2026-02-30T12:00:00Z' },
    { occurred_at: '0000-01-01T00:00:00Z' },
    { occurred_at: '2026-10-02T24:00:00Z' },
    { occurred_at: '2026-10-02T12:00:60Z' },
    { occurred_at: '2026-10-02T12:00:00.1234567Z' },
    { occurred_at: '2026-10-02T12:00:00+00:00' },
    { event_type: 'session.created' },
    { event_type: 'task.deleted' },
    { resource_kind: 'plan' },
    { id: '00000000-0000-0000-0000-000000000000' },
    { revision: 1 },
    { request_id: otherID },
  ])
    expect(() => parsePage(page([{ ...event(), ...delta }]))).toThrow(APIError)
  expect(() => parsePage({ ...page([event()]), total: 1 })).toThrow(APIError)
  expect(() =>
    parsePage({ ...page([event()]), page: { limit: 25, next_cursor: null, metadata: 'private' } }),
  ).toThrow(APIError)
  expect(() => parsePage(page([{ ...event(1, 'client.created'), resource_id: otherID }]))).toThrow(
    APIError,
  )
  expect(parsePage(page([event(1, 'client.created', '0001-01-01T00:00:00Z')])).data).toHaveLength(1)
  expect(
    parsePage(page([event(1, 'client.created', '9999-12-31T23:59:59.999999Z')])).data,
  ).toHaveLength(1)
})
it('validates descending microseconds, UUID ties, uniqueness and bounded continuation pages', () => {
  expect(
    parsePage(
      page([
        event(1, 'task.updated', '2026-10-02T12:00:00.123456Z'),
        event(2, 'task.updated', '2026-10-02T12:00:00.123455Z'),
      ]),
    ).data,
  ).toHaveLength(2)
  expect(parsePage(page([event(2), event(1)])).data).toHaveLength(2)
  const full = Array.from({ length: 25 }, (_, i) => event(25 - i))
  expect(parsePage(page(full, 'opaque_Cursor-1')).data).toHaveLength(25)
  for (const invalid of [
    page([event(1), event(2)]),
    page([event(1), event(1)]),
    page(Array(26).fill(event())),
    page([event()], 'cursor'),
    page(full, 'bad='),
    page(full, 'x'.repeat(257)),
    { data: [], page: { limit: 100, next_cursor: null } },
    page([{ ...event(2), occurred_at: 'invalid' }, event(1)]),
  ])
    expect(() => parsePage(invalid)).toThrow(APIError)
})
it('sends only a bounded read with the unchanged opaque cursor and rejects cross-client/loop responses', async () => {
  fetcher.mockResolvedValueOnce(json(page([event()])))
  await api.list(clientID, 'opaque_Cursor-1', new AbortController().signal)
  expect(fetcher.mock.calls[0]![0]).toBe(
    `/api/v1/clients/${clientID}/activity?limit=25&cursor=opaque_Cursor-1`,
  )
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    body: null,
  })
  fetcher.mockResolvedValueOnce(json(page([{ ...event(), client_id: otherID }])))
  await expect(api.list(clientID, '', new AbortController().signal)).rejects.toThrow(APIError)
  fetcher.mockResolvedValueOnce(
    json(
      page(
        Array.from({ length: 25 }, (_, i) => event(25 - i)),
        'loop',
      ),
    ),
  )
  await expect(api.list(clientID, 'loop', new AbortController().signal)).rejects.toThrow(APIError)
  const calls = fetcher.mock.calls.length
  for (const [id, cursor] of [
    ['invalid', ''],
    [clientID, '../private'],
    [clientID, 'x'.repeat(257)],
  ])
    await expect(api.list(id!, cursor!, new AbortController().signal)).rejects.toThrow(APIError)
  expect(fetcher.mock.calls).toHaveLength(calls)
})
