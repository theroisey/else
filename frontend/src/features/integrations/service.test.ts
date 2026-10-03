import { expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { parseConnection, parseDisconnect, parsePage } from './models'
import { integrationPermissions } from './permissions'
import { safeReturnTo } from '../shell/navigation'
import {
  clientID,
  otherID,
  connection,
  page,
  cursor,
  identity,
} from './fixtures.test-data'
import * as api from './service'
const record = connection()
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
const disabled = () => ({
  data: { ...record, state: 'revocation_failed', revision: '9007199254740994' },
  revocation: { status: 'unavailable', manual_action_required: true },
})
it('retains int64 precision and exact microseconds', () => {
  expect(parseConnection({ data: record }, clientID, record.id)).toEqual(record)
  expect(
    parseConnection(
      { data: { ...record, revision: '9223372036854775807' } },
      clientID,
      record.id,
    ).revision,
  ).toBe('9223372036854775807')
})
it.each([
  { revision: 1 },
  { revision: '0' },
  { revision: '01' },
  { revision: '-1' },
  { revision: '1e3' },
  { revision: 'invalid' },
  { revision: '9223372036854775808' },
  { provider: 'unknown' },
  { state: 'revoked' },
  { id: otherID },
  { client_id: otherID },
  { id: record.id.toUpperCase() },
  { id: '00000000-0000-0000-0000-000000000000' },
  { created_at: '2026-02-30T12:00:00Z' },
  { updated_at: '2026-10-03T12:00:00.123455Z' },
  { updated_at: '2026-10-03T12:00:00+00:00' },
  { updated_at: '0000-01-01T00:00:00Z' },
  { updated_at: '2026-10-03T12:00:00.1234567Z' },
  { updated_at: 'invalid' },
  { provider_account_id: 'Synthetic private account' },
  { credential: 'Synthetic private value' },
  { generation: '2' },
])('rejects malformed or expanded metadata %j safely', (patch) => {
  expect(() =>
    parseConnection({ data: { ...record, ...patch } }, clientID, record.id),
  ).toThrow(APIError)
})
it('validates same-client ascending pages, cursor boundary and envelope', () => {
  const rows = Array.from({ length: 25 }, (_, i) => connection(i + 1))
  expect(
    parsePage(page(rows, cursor(rows.at(-1)!.id)), clientID).data,
  ).toHaveLength(25)
  for (const bad of [
    page([record, record]),
    page([...rows].reverse()),
    page([{ ...record, client_id: otherID }]),
    page(rows, cursor(record.id)),
    page(rows, cursor(rows.at(-1)!.id, otherID)),
    page([record], cursor(record.id)),
    page(rows, cursor(rows.at(-1)!.id) + '='),
    { ...page([record]), private: true },
    { ...page([record]), page: { limit: 100, next_cursor: null } },
  ]) {
    expect(() => parsePage(bad, clientID)).toThrow(APIError)
  }
  expect(() => parsePage(page([record]), clientID, record.id)).toThrow(APIError)
})
it('rejects invalid routes and cross-client request cursors before transport', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(
    api.list(
      clientID,
      cursor(record.id, otherID),
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(APIError)
  await expect(
    api.list(clientID, 'bad', new AbortController().signal),
  ).rejects.toBeInstanceOf(APIError)
  await expect(
    api.detail('../private', record.id, new AbortController().signal),
  ).rejects.toBeInstanceOf(APIError)
  await expect(
    api.disconnect(connection(1, 'disconnected')),
  ).rejects.toBeInstanceOf(APIError)
  expect(fetcher).not.toHaveBeenCalled()
})
it('uses bounded reads and cookie/CSRF authenticated confirmation without coercing revision', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(page([record])))
    .mockResolvedValueOnce(json({ data: record }))
    .mockResolvedValueOnce(json(disabled()))
  vi.stubGlobal('fetch', fetcher)
  await api.list(clientID, '', new AbortController().signal)
  await api.detail(clientID, record.id, new AbortController().signal)
  expect(await api.disconnect(record)).toEqual(disabled())
  expect(fetcher.mock.calls[0]![0]).toBe(
    `/api/v1/clients/${clientID}/integrations?limit=25`,
  )
  const [url, options] = fetcher.mock.calls[2]!
  expect(url).toBe(
    `/api/v1/clients/${clientID}/integrations/${record.id}/disconnect`,
  )
  expect(options).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'a'.repeat(43),
    },
  })
  expect(JSON.parse(options.body)).toEqual({
    revision: record.revision,
    confirmed: true,
  })
})
it('requires an honest unavailable outcome and reconciled identity, state and revision', () => {
  expect(parseDisconnect(disabled(), record).data.state).toBe(
    'revocation_failed',
  )
  for (const bad of [
    {
      ...disabled(),
      revocation: { status: 'revoked', manual_action_required: false },
    },
    {
      ...disabled(),
      revocation: {
        status: 'unavailable',
        manual_action_required: true,
        token: 'private',
      },
    },
    ...[
      { id: otherID },
      { client_id: otherID },
      { state: 'disconnected' },
      { revision: record.revision },
      { created_at: '2026-10-02T00:00:00Z' },
      { generation: '2' },
    ].map((patch) => ({
      ...disabled(),
      data: { ...disabled().data, ...patch },
    })),
  ])
    expect(() => parseDisconnect(bad, record)).toThrow(APIError)
})
it('evaluates independent exact-client view and manage grants, and safe deep links', () => {
  for (const missing of ['clients.view', 'integrations.view'])
    expect(
      integrationPermissions(
        identity.user.permissions.filter((g) => g.permission !== missing),
        clientID,
      ).view,
    ).toBe(false)
  expect(
    integrationPermissions(
      identity.user.permissions.filter(
        (g) => g.permission !== 'integrations.manage',
      ),
      clientID,
    ),
  ).toEqual({ view: true, manage: false })
  expect(integrationPermissions(identity.user.permissions, otherID).view).toBe(
    false,
  )
  for (const route of [
    `/app/clients/${clientID}/integrations`,
    `/app/clients/${clientID}/integrations/${record.id}`,
  ])
    expect(safeReturnTo(route)).toBe(route)
  for (const route of [
    `/app/clients/${clientID}/integrations/connect`,
    `/app/clients/${clientID}/integrations/${record.id}/disconnect`,
    '/app/clients/invalid/integrations',
  ])
    expect(safeReturnTo(route)).toBe('/app')
})
