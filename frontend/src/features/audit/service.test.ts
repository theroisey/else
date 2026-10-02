import { beforeEach, expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo, visibleDestinations } from '../shell/navigation'
import { auditPermissions } from './permissions'
import {
  emptyFilters,
  differences,
  markerValue,
  parseDetail,
  parsePage,
  snapshotState,
  validateFilters,
} from './models'
import {
  actorID,
  clientID,
  detail,
  event,
  identity,
  otherID,
  page,
  requestID,
} from './fixtures.test-data'
import * as service from './service'
const fetcher = vi.fn()
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
beforeEach(() => {
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
it('requires a global audit capability and independent client visibility, with no business-domain grants', () => {
  const grants = identity.user.permissions
  expect(auditPermissions(grants, clientID).allows(event())).toBe(true)
  expect(auditPermissions(grants, otherID).view).toBe(false)
  expect(auditPermissions([grants[0]!]).allows(event())).toBe(false)
  expect(
    auditPermissions([grants[0]!]).allows(event(1, { client_id: null })),
  ).toBe(true)
  expect(
    auditPermissions(
      [
        { permission: 'audit.view', scope: 'client', client_id: clientID },
        grants[1]!,
      ],
      clientID,
    ).view,
  ).toBe(false)
  expect(
    auditPermissions(
      [
        { permission: 'clients.view', scope: 'global' },
        { permission: 'activity.view', scope: 'global' },
      ],
      clientID,
    ).view,
  ).toBe(false)
  expect(visibleDestinations(grants).some((d) => d.path === '/app/audit')).toBe(
    true,
  )
  expect(
    visibleDestinations([grants[1]!]).some((d) => d.path === '/app/audit'),
  ).toBe(false)
  for (const path of ['/app/audit', `/app/clients/${clientID}/audit`])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    '/app/audit?client_id=private',
    `/app/clients/${clientID}/audit/edit`,
    '/app/clients/invalid/audit',
  ])
    expect(safeReturnTo(path)).toBe('/app')
})
it('rejects expanded summaries, invalid actor/kind/event/time contracts and unsafe envelopes', () => {
  expect(parsePage(page([event(2), event(1)]))).toBeTruthy()
  expect(
    parsePage(
      page([
        event(1, {
          actor_kind: 'system',
          actor_user_id: null,
          client_id: null,
          event_type: 'job.created',
          resource_kind: 'job',
        }),
      ]),
    ),
  ).toBeTruthy()
  for (const delta of [
    { metadata: { source: 'http' } },
    { before_state: {} },
    { display_name: 'Synthetic private name' },
    { schema_version: 2 },
    { actor_kind: 'system' },
    { actor_user_id: null },
    { event_type: 'task.updated.' },
    { event_type: 'role.disabled' },
    { resource_kind: 'reminder' },
    { occurred_at: '2026-02-30T00:00:00Z' },
    { occurred_at: '2026-10-02T12:00:00.1234560Z' },
    { occurred_at: '0000-01-01T00:00:00Z' },
    { request_id: 'private' },
    { id: '00000000-0000-0000-0000-000000000000' },
  ])
    expect(() => parsePage(page([{ ...event(), ...delta }]))).toThrow(APIError)
  for (const value of [
    { ...page([]), total: 0 },
    page([event(1), event(2)]),
    page([event(2), event(1, { occurred_at: 'invalid' })]),
    page([event(), event()]),
    page([event()], 'cursor'),
    page(Array(26).fill(event())),
  ])
    expect(() => parsePage(value)).toThrow(APIError)
  expect(
    parsePage(page([event(1, { occurred_at: '0001-01-01T00:00:00Z' })])),
  ).toBeTruthy()
  expect(
    parsePage(page([event(1, { occurred_at: '9999-12-31T23:59:59.999999Z' })])),
  ).toBeTruthy()
})
it('preserves exact revision/time strings and rejects storage expansion or invalid typed markers', () => {
  expect(parseDetail({ data: detail() }).after_state!.revision).toBe(
    '9223372036854775807',
  )
  for (const state of [
    { revision: 9007199254740992 },
    { revision: '01' },
    { revision: '-1' },
    { revision: '9223372036854775808' },
    { revision: 'private' },
    { title: 'Synthetic secret' },
    { task_status: 'secret' },
    { planning_status: 'draft' },
    { reminder_status: 'pending' },
    { status: 'archived' },
    { revision: null },
  ])
    expect(() =>
      parseDetail({ data: { ...detail(), after_state: state } }),
    ).toThrow(APIError)
  for (const metadata of [
    { source: 'private' },
    { source: 'http', token: 'Synthetic secret' },
    null,
  ])
    expect(() => parseDetail({ data: { ...detail(), metadata } })).toThrow(
      APIError,
    )
  expect(() =>
    parseDetail({ data: { ...detail(), actor_email: 'private' } }),
  ).toThrow(APIError)
  const reminder = detail(
    event(1, { event_type: 'reminder.updated', resource_kind: 'reminder' }),
  )
  expect(
    parseDetail({
      data: {
        ...reminder,
        before_state: null,
        after_state: {
          reminder_scheduled_at: '2026-10-02T12:00:00.123456Z',
          reminder_timezone: 'UTC',
        },
      },
    }),
  ).toBeTruthy()
  for (const state of [
    { reminder_scheduled_at: '2026-10-02T12:00:00Z' },
    { reminder_timezone: 'UTC' },
    {
      reminder_scheduled_at: '2026-10-02T12:00:00Z',
      reminder_timezone: 'invalid',
    },
  ])
    expect(() =>
      parseDetail({
        data: { ...reminder, before_state: null, after_state: state },
      }),
    ).toThrow(APIError)
})
it('compares only present reviewed markers and distinguishes null, empty and unchanged snapshots', () => {
  expect(
    differences(
      { revision: '9007199254740992', exists: false },
      { revision: '9007199254740993', exists: true },
    ),
  ).toEqual([
    { key: 'exists', label: 'Record exists', before: false, after: true },
    {
      key: 'revision',
      label: 'Revision',
      before: '9007199254740992',
      after: '9007199254740993',
    },
  ])
  expect(differences({ task_status: 'todo' }, { task_status: 'todo' })).toEqual(
    [],
  )
  expect(differences(null, {})).toEqual([])
  expect(differences({ exists: true }, null)[0]!.after).toBeUndefined()
  expect(snapshotState(null)).toBe('Not recorded')
  expect(snapshotState({})).toBe('Empty snapshot')
  expect(markerValue('America/New_York', 'reminder_timezone')).toBe(
    'America/New_York',
  )
  expect(markerValue('in_progress', 'task_status')).toBe('in progress')
})
it('validates exact filters and ordered UTC ranges without truncating microseconds', () => {
  expect(
    validateFilters({
      ...emptyFilters,
      actor_id: actorID.toUpperCase(),
      from: '2026-10-02T12:00:00.123455Z',
      to: '2026-10-02T12:00:00.123456Z',
    }).actor_id,
  ).toBe(actorID)
  for (const delta of [
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-10-02T00:00:00+00:00' },
    { to: '2026-10-02T12:00:00.1234560Z' },
    { from: '2026-10-02T12:00:00.123456Z', to: '2026-10-02T12:00:00.123455Z' },
    { actor_id: 'invalid' },
    { resource_kind: 'task.private' },
    { event_type: 'user.completed' },
  ])
    expect(() => validateFilters({ ...emptyFilters, ...delta })).toThrow(
      APIError,
    )
  expect(() =>
    validateFilters({ ...emptyFilters, client_id: clientID }, clientID),
  ).toThrow(APIError)
})
it('uses bounded GET-only no-store transport with exact filters and unchanged cursors', async () => {
  fetcher.mockResolvedValue(json(page([event()])))
  await service.list(
    undefined,
    {
      ...emptyFilters,
      actor_id: actorID,
      event_type: 'task.updated',
      client_id: clientID,
      resource_kind: 'task',
      resource_id: otherID,
      request_id: requestID,
      from: '2026-10-02T12:00:00.123456Z',
      to: '2026-10-02T12:00:00.123457Z',
    },
    'opaque_Cursor-1',
    new AbortController().signal,
  )
  const query = new URL(fetcher.mock.calls[0]![0], 'https://fixture.test')
    .searchParams
  expect(query.get('from')).toBe('2026-10-02T12:00:00.123456Z')
  expect(query.get('cursor')).toBe('opaque_Cursor-1')
  expect(fetcher.mock.calls[0]![1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    body: null,
  })
  fetcher.mockResolvedValue(json({ data: detail() }))
  await service.inspect(clientID, event(), new AbortController().signal)
  expect(fetcher.mock.calls.at(-1)![0]).toBe(
    `/api/v1/clients/${clientID}/audit-logs/${event().id}`,
  )
})
it('rejects cross-client/filter/detail mismatch, repeated cursors and invalid endpoints', async () => {
  fetcher.mockResolvedValue(json(page([event(1, { client_id: otherID })])))
  await expect(
    service.list(clientID, emptyFilters, '', new AbortController().signal),
  ).rejects.toThrow(APIError)
  fetcher.mockResolvedValue(json(page([event()])))
  await expect(
    service.list(
      undefined,
      { ...emptyFilters, event_type: 'task.created' },
      '',
      new AbortController().signal,
    ),
  ).rejects.toThrow(APIError)
  fetcher.mockResolvedValue(
    json(
      page(
        Array.from({ length: 25 }, (_, i) => event(25 - i)),
        'loop',
      ),
    ),
  )
  await expect(
    service.list(undefined, emptyFilters, 'loop', new AbortController().signal),
  ).rejects.toThrow(APIError)
  fetcher.mockResolvedValue(
    json({ data: detail(event(1, { client_id: otherID })) }),
  )
  await expect(
    service.inspect(undefined, event(), new AbortController().signal),
  ).rejects.toThrow(APIError)
  const calls = fetcher.mock.calls.length
  await expect(
    service.list('invalid', emptyFilters, '', new AbortController().signal),
  ).rejects.toThrow(APIError)
  await expect(
    service.list(
      undefined,
      emptyFilters,
      '../private',
      new AbortController().signal,
    ),
  ).rejects.toThrow(APIError)
  expect(fetcher.mock.calls).toHaveLength(calls)
})
