import { expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'
import { amount, parseCatalog, parseView, spendUnits, validPeriod } from './models'
import { clientID, otherID, record, period, measured, empty } from './fixtures.test-data'
import * as api from './service'

it('validates weighted ratios, exact large decimal strings and account-local dates', () => {
  const value = parseView(measured(), clientID, record.id, period)
  expect(value.data?.report.totals.ctr_percent).toBe('1.980198')
  expect(value.data?.report.days.map(row => row.date)).toEqual(['2026-10-01', '2026-10-03'])
  expect(spendUnits('9007199254740993.123456')).toBe(9007199254740993123456n)
  expect(amount('9007199254740993.123456', 'KWD')).toBe('KWD 9,007,199,254,740,993.123456')
  expect(parseView(empty, clientID, record.id, period)).toEqual(empty)
})
it('refuses private fields, incomplete bindings, arithmetic, ratios and collection times', () => {
  const invalid: unknown[] = []
  for (const patch of [{ client_id: otherID }, { connection_id: otherID }, { since: period.until }, { currency: 'usd' }, { timezone: 'Local' }, { graph_version: 'v21.0' }, { attribution_status: 'measured' }, { account_id: '123456789' }]) {
    const value = measured(); invalid.push({ ...value, data: { ...value.data, report: { ...value.data!.report, ...patch } } })
  }
  for (const patch of [{ spend_decimal: '1.0' }, { spend_decimal: '-1' }, { clicks: 1 }, { impressions: '01' }, { ctr_percent: null }, { ctr_percent: '1.0' }, { cpc_decimal: '1.000001' }, { date: '2026-09-30' }, { actions: [] }]) {
    const value = measured(); invalid.push({ ...value, data: { ...value.data, report: { ...value.data!.report, days: [{ ...value.data!.report.days[0], ...patch }, value.data!.report.days[1]] } } })
  }
  const duplicate = measured(); duplicate.data!.report.days.push({ ...duplicate.data!.report.days[0]! }); invalid.push(duplicate)
  const sum = measured(); sum.data!.report.totals.spend_decimal = '4'; invalid.push(sum)
  const average = measured(); average.data!.report.totals.ctr_percent = '50.500000'; invalid.push(average)
  const interval = measured(); interval.data!.collected_through = '2026-10-04T10:02:02Z'; invalid.push(interval)
  const reversed = measured(); reversed.data!.collected_through = '2026-10-04T09:59:59Z'; invalid.push(reversed)
  const noncanonical = measured(); noncanonical.data!.collected_from = '2026-10-04T10:00:00.123450Z'; invalid.push(noncanonical)
  invalid.push({ ...empty, access_token: 'private' }, { ...empty, status: { ...empty.status, stale: false } })
  for (const value of invalid) expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
})
it('keeps zero-denominator ratios unavailable and empty observations distinct', () => {
  const value = measured(), r = value.data!.report
  r.days = [{ date: period.since, spend_decimal: '1', impressions: '0', clicks: '0', ctr_percent: null, cpc_decimal: null, cpm_decimal: null }]
  r.totals = { ...r.days[0]! }; delete (r.totals as { date?: string }).date
  expect(parseView(value, clientID, record.id, period).data?.report.totals.cpc_decimal).toBeNull()
  r.totals.cpc_decimal = '0.000000'
  expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
  r.days = []; r.totals = { spend_decimal: '0', impressions: '0', clicks: '0', ctr_percent: null, cpc_decimal: null, cpm_decimal: null }
  expect(parseView(value, clientID, record.id, period).data?.report.days).toEqual([])
})
it('bounds inclusive real calendar dates, catalog provider metadata and deep links', () => {
  expect(validPeriod({ since: '2026-03-01', until: '2026-03-31' })).toBe(true)
  for (const patch of [{ since: '2026-02-30' }, { until: '2026-11-01' }, { until: '2026-09-30' }, { since: '1999-12-31' }]) expect(validPeriod({ ...period, ...patch })).toBe(false)
  expect(parseCatalog({ data: [record], next_id: null }, clientID).data).toEqual([record])
  for (const value of [{ data: [{ ...record, provider: 'ga4' }], next_id: null }, { data: [record, record], next_id: null }, { data: [{ ...record, account_id: '123' }], next_id: null }]) expect(() => parseCatalog(value, clientID)).toThrow(APIError)
  for (const path of [`/app/clients/${clientID}/marketing`, `/app/clients/${clientID}/marketing/${record.id}`]) expect(safeReturnTo(path)).toBe(path)
  expect(safeReturnTo(`/app/clients/${clientID}/marketing/private`)).toBe('/app')
})
it('rejects unsafe token/account/state inputs before transport', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  for (const account of ['act_123', '01', 'https://private.example', '1'.repeat(21)]) await expect(api.create(clientID, account)).rejects.toBeInstanceOf(APIError)
  for (const token of ['', 'short', 'SyntheticToken private', 'SyntheticToken\nprivate', 'a'.repeat(4097), 'SyntheticToken?token=private']) await expect(api.queue(record, period, token)).rejects.toBeInstanceOf(APIError)
  await expect(api.queue({ ...record, state: 'disconnected' }, period)).rejects.toBeInstanceOf(APIError)
  await expect(api.read('../private', record.id, period, new AbortController().signal)).rejects.toBeInstanceOf(APIError)
  expect(fetcher).not.toHaveBeenCalled()
})
it('sends a token only in a single authenticated mutation body with exact queued revision', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: otherID, state: 'queued', connection_revision: '9007199254740995' }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  await api.queue(record, period, 'SyntheticReadTokenFixture123456')
  const [url, options] = fetcher.mock.calls[0]!
  expect(url).toBe(`/api/v1/clients/${clientID}/integrations/${record.id}/meta_ads/credentials`)
  expect(JSON.parse(options.body)).toEqual({ revision: record.revision, ...period, access_token: 'SyntheticReadTokenFixture123456' })
  expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-CSRF-Token': 'a'.repeat(43) } })
  expect(fetcher).toHaveBeenCalledOnce()
})
