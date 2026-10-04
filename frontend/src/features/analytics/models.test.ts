import { expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'
import { parseCatalog, parseQueued, parseView, validPeriod } from './models'
import { clientID, otherID, record, period, measured, empty } from './fixtures.test-data'
import * as api from './service'

it('preserves exact counts and fractional key events in independent summary and detail reports', () => {
  const result = parseView(measured(), clientID, record.id, period)
  expect(result.data?.summary.rows[0]?.metrics).toEqual(['9007199254740993', '12', '18', '1.3333333333333333'])
  expect(parseView(empty, clientID, record.id, period)).toEqual(empty)
})
it('accepts provider multiline definitions as plain text within the backend UTF-8 budget', () => {
  const value = measured()
  value.data!.definitions[0]!.description = 'Synthetic definition\n\t<script>provider text</script>'
  expect(parseView(value, clientID, record.id, period).data?.definitions[0]?.description).toContain('<script>')
  value.data!.definitions[0]!.description = '界'.repeat(1500)
  expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
  value.data!.definitions[0]!.description = 'Synthetic\u0000private'
  expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
})
it('fails closed for expanded data, foreign bindings, template changes and unsafe landing paths', () => {
  const bad = []
  for (const patch of [{ client_id: otherID }, { connection_id: otherID }, { since: '2026-10-02' }, { timezone: 'America/New_York' }, { api_version: 'v2' }, { credential: 'Synthetic secret' }, { metrics: ['activeUsers', 'sessions', 'screenPageViews', 'eventCount'] }]) {
    const value = measured(); bad.push({ ...value, data: { ...value.data, daily: { ...value.data!.daily, ...patch } } })
  }
  for (const dimension of ['//foreign.example', '/synthetic?email=private', '/synthetic#private', '/synthetic\\private', '/user@private', 'https://foreign.example']) {
    const value = measured(); value.data!.landing.rows = [{ dimensions: [dimension], metrics: ['1', '1', '1', '0'] }]; bad.push(value)
  }
  for (const metric of [1, '01', '1e3', '-1', 'NaN', '0.10']) {
    const value = measured(); value.data!.summary.rows = [{ dimensions: [], metrics: ['1', '1', '1', metric as string] }]; bad.push(value)
  }
  const count = measured(); count.data!.summary.rows[0]!.metrics = ['1.5', '1', '1', '0']; bad.push(count)
  const duplicate = measured(); duplicate.data!.daily.rows.push({ ...duplicate.data!.daily.rows[0]! }); bad.push(duplicate)
  const invalidDate = measured(); invalidDate.data!.daily.rows[0]!.dimensions = ['20261032']; bad.push(invalidDate)
  for (const value of bad) expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
  expect(() => parseView({ ...empty, secret: 'Synthetic key' }, clientID, record.id, period)).toThrow(APIError)
  expect(() => parseView({ status: { ...empty.status, stale: false }, data: null }, clientID, record.id, period)).toThrow(APIError)
  expect(() => parseView({ status: { ...empty.status, state: 'failed' }, data: null }, clientID, record.id, period)).toThrow(APIError)
})
it('validates explicit real property dates and 31-day bounds without local timezone coercion', () => {
  expect(validPeriod({ since: '2026-01-01', until: '2026-01-31' })).toBe(true)
  for (const value of [{ since: '2026-01-01', until: '2026-02-01' }, { since: '2026-02-30', until: '2026-03-01' }, { since: '2026-03-02', until: '2026-03-01' }, { since: '1999-01-01', until: '1999-01-02' }]) expect(validPeriod(value)).toBe(false)
})
it('restricts analytics catalog to client-bound GA4 and exact keyset pages', () => {
  expect(parseCatalog({ data: [record], next_id: null }, clientID).data).toEqual([record])
  for (const value of [{ data: [{ ...record, provider: 'meta_ads' }], next_id: null }, { data: [{ ...record, client_id: otherID }], next_id: null }, { data: [record, record], next_id: null }, { data: [record], next_id: record.id }]) expect(() => parseCatalog(value, clientID)).toThrow(APIError)
  expect(parseQueued({ job_id: otherID, state: 'queued', connection_revision: '9007199254740995' }, 9007199254740995n).connection_revision).toBe('9007199254740995')
  expect(() => parseQueued({ job_id: otherID, state: 'queued', connection_revision: '9007199254740993' }, 9007199254740995n)).toThrow(APIError)
})
it('rejects invalid scopes, write revisions and key bounds before transport and permits safe deep links', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  await expect(api.read('../private', record.id, period, new AbortController().signal)).rejects.toBeInstanceOf(APIError)
  await expect(api.queue({ ...record, state: 'revocation_failed' }, period)).rejects.toBeInstanceOf(APIError)
  await expect(api.queue(record, period, '界'.repeat(6000))).rejects.toBeInstanceOf(APIError)
  await expect(api.create(clientID, '0')).rejects.toBeInstanceOf(APIError)
  expect(fetcher).not.toHaveBeenCalled()
  for (const path of [`/app/clients/${clientID}/analytics`, `/app/clients/${clientID}/analytics/${record.id}`]) expect(safeReturnTo(path)).toBe(path)
  expect(safeReturnTo(`/app/clients/${clientID}/analytics/invalid`)).toBe('/app')
})
it('queues a bounded explicit period with the saved key and reconciles the returned revision', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: otherID, state: 'queued', connection_revision: record.revision }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  await api.queue(record, period)
  expect(fetcher).toHaveBeenCalledOnce()
  const [url, options] = fetcher.mock.calls[0]!
  expect(url).toBe(`/api/v1/clients/${clientID}/integrations/${record.id}/ga4/sync`)
  expect(JSON.parse(options.body)).toEqual({ revision: record.revision, ...period })
  expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
})
