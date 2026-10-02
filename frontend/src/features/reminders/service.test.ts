import { beforeEach, expect, it, vi } from 'vitest'
import { safeReturnTo } from '../shell/navigation'
import { reminderPermissions } from './permissions'
import { parseRecord, parsePage, parseOwners, profileSchema, defaultFilter } from './models'
import { reminder, clientID, recordID, actorID, identity, otherID } from './fixtures.test-data'
import * as api from './service'
const fetcher = vi.fn(),
  response = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher)
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
})
it('accepts only validated reminder return paths and requires exact view alongside writes', () => {
  const base = `/app/clients/${clientID}/reminders`
  for (const path of [base, base + '/new', base + '/' + recordID, base + '/' + recordID + '/edit'])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    base + '/new/edit',
    base + '/../users',
    base + '/' + recordID + '?private=1',
    base + '/' + recordID + '/dismiss',
    '/app/clients/invalid/reminders',
  ])
    expect(safeReturnTo(path)).toBe('/app')
  expect(reminderPermissions(identity.user.permissions, clientID).update).toBe(true)
  expect(
    reminderPermissions([{ permission: 'reminders.update', scope: 'global' }], clientID).update,
  ).toBe(false)
  expect(reminderPermissions(identity.user.permissions, otherID).view).toBe(false)
})
it('validates stored arithmetic and terminal markers without reinterpreting current timezone rules', () => {
  expect(parseRecord({ data: reminder })).toEqual(reminder)
  for (const delta of [
    { scheduled_at: '2026-11-01T05:30:00.123456Z' },
    { utc_offset_seconds: -14400 },
    { status: 'completed' },
    { is_due: true, status: 'dismissed', dismissed_at: reminder.updated_at },
    { scheduled_local: '2026-02-30T12:00:00' },
    { scheduled_at: '2026-11-01T06:30:00.1234567Z' },
    { scheduled_at: '2026-11-01T07:30:00.123456+01:00' },
    { revision: 0 },
    { timezone: 'Local' },
  ])
    expect(() => parseRecord({ data: { ...reminder, ...delta } })).toThrow()
  expect(
    parseRecord({
      data: {
        ...reminder,
        scheduled_at: '2026-03-08T07:30:00Z',
        scheduled_local: '2026-03-08T02:30:00',
        utc_offset_seconds: -18000,
      },
    }).scheduled_at,
  ).toBe('2026-03-08T07:30:00Z')
})
it('rejects unbounded pages, repeated IDs, wrong cursors and expanded owner/resource metadata', () => {
  const p = { data: [reminder], page: { limit: 25, next_cursor: null } }
  expect(parsePage(p).data).toHaveLength(1)
  for (const body of [
    { ...p, data: Array(26).fill(reminder) },
    { ...p, data: [reminder, reminder] },
    { ...p, page: { limit: 25, next_cursor: recordID } },
    { ...p, page: { limit: 100, next_cursor: null } },
  ])
    expect(() => parsePage(body)).toThrow()
  expect(() =>
    parseOwners({
      data: [{ id: actorID, display_name: 'Owner', email: 'private@example.com' }],
      page: p.page,
    }),
  ).toThrow()
  expect(() =>
    parseRecord({
      data: { ...reminder, resource: { kind: 'task', id: actorID, title: 'private' } },
    }),
  ).toThrow()
})
it('sends bounded literal filters and verifies client/target identity on responses', async () => {
  fetcher.mockResolvedValueOnce(
    response({ data: [reminder], page: { limit: 25, next_cursor: null } }),
  )
  await api.list(
    clientID,
    { ...defaultFilter, q: ' % ', due: 'due', owner: 'me' },
    '',
    new AbortController().signal,
  )
  const url = new URL(fetcher.mock.calls[0]![0], 'https://example.test')
  expect(url.searchParams.get('q')).toBe('%')
  expect(url.searchParams.get('limit')).toBe('25')
  expect(url.searchParams.get('owner')).toBe('me')
  fetcher.mockResolvedValueOnce(response({ data: { ...reminder, client_id: actorID } }))
  await expect(api.detail(clientID, recordID)).rejects.toThrow()
  fetcher.mockResolvedValueOnce(response({ data: { ...reminder, id: actorID } }))
  await expect(api.detail(clientID, recordID)).rejects.toThrow()
  await expect(api.detail('invalid', recordID)).rejects.toThrow()
})
it('submits reviewed metadata only and confirms exact mutation revisions and dismissal', async () => {
  const profile = profileSchema.parse({
    ...reminder,
    client_id: actorID,
    status: 'completed',
    created_by: actorID,
  })
  fetcher.mockResolvedValueOnce(response({ data: { id: recordID, revision: 2 } }))
  await api.update(clientID, recordID, profile, 1)
  const body = JSON.parse(fetcher.mock.calls[0]![1].body)
  expect(body).toEqual({ ...profile, expected_revision: 1 })
  expect(body).not.toHaveProperty('scheduled_at')
  expect(body).not.toHaveProperty('status')
  fetcher.mockResolvedValueOnce(response({ data: { id: recordID, revision: 3 } }))
  await api.finish(clientID, recordID, 'dismiss', 2)
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    expected_revision: 2,
    confirm: true,
  })
  fetcher.mockResolvedValueOnce(response({ data: { id: actorID, revision: 2 } }))
  await expect(api.finish(clientID, recordID, 'complete', 1)).rejects.toThrow()
  fetcher.mockResolvedValueOnce(response({ data: { id: recordID, revision: 8 } }))
  await expect(api.finish(clientID, recordID, 'complete', 1)).rejects.toThrow()
  await expect(api.finish(clientID, recordID, 'complete', 0)).rejects.toThrow()
})
