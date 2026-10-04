import { expect, it, vi } from 'vitest'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'
import { dailyObservations, money, parseCatalog, parseQueued, parseView, validPeriod } from './models'
import { clientID, otherID, record, period, measured, empty } from './fixtures.test-data'
import * as api from './service'

it('retains exact large amounts and quantities and keeps separate observed daily cohorts', () => {
  const value = parseView(measured(), clientID, record.id, period)
  expect(value.data?.orders.grand_total_minor).toBe('9007199254740993')
  expect(value.data?.products.products[0]?.quantity).toBe('9007199254740993')
  expect(money(value.data!.orders.grand_total_minor, 'USD')).toBe('USD 90,071,992,547,409.93')
  expect(money('123', 'JPY')).toBe('JPY 123')
  expect(money('123', 'KWD')).toBe('KWD 0.123')
  expect(dailyObservations(value.data!)).toEqual([
    { day: '2026-10-01', orderGrand: 9007199254740993n, refundAmount: null },
    { day: '2026-10-03', orderGrand: null, refundAmount: 123n },
  ])
  expect(parseView(empty, clientID, record.id, period)).toEqual(empty)
})
it('rejects expanded private fields, incorrect bindings, currencies and arithmetic atomically', () => {
  const invalid: unknown[] = []
  for (const patch of [{ client_id: otherID }, { connection_id: otherID }, { start: '2026-10-02T00:00:00Z' }, { currency: 'JPY' }, { currency_exponent: null }, { currency_exponent: 0 }, { api_version: 'wc/v2' }, { billing: { email: 'private@example.com' } }]) {
    const value = measured(); invalid.push({ ...value, data: { ...value.data, orders: { ...value.data!.orders, ...patch } } })
  }
  for (const patch of [{ id: '01' }, { grand_total_minor: 123 }, { grand_total_minor: '1e3' }, { grand_total_minor: '-1' }, { grand_total_minor: '1.00' }, { lifetime_refund_minor: '2' }, { created_at: period.end }, { created_at: '2026-10-02T00:00:00+00:00' }, { customer_id: '1' }]) {
    const value = measured(); invalid.push({ ...value, data: { ...value.data, orders: { ...value.data!.orders, orders: [{ ...value.data!.orders.orders[0], ...patch }] } } })
  }
  const duplicate = measured(); duplicate.data!.orders.orders.push({ ...duplicate.data!.orders.orders[0]! }); invalid.push(duplicate)
  const summary = measured(); summary.data!.orders.grand_total_minor = '9007199254740992'; invalid.push(summary)
  const refund = measured(); refund.data!.refunds.refunds[0]!.id = refund.data!.orders.orders[0]!.id; invalid.push(refund)
  const refundSum = measured(); refundSum.data!.refunds.amount_minor = '124'; invalid.push(refundSum)
  for (const patch of [{ quantity: '0' }, { order_count: '2' }, { line_count: '51' }, { line_grand_minor: '1' }, { product_id: '00' }, { name: 'private product' }]) {
    const value = measured(); invalid.push({ ...value, data: { ...value.data, products: { ...value.data!.products, products: [{ ...value.data!.products.products[0], ...patch }] } } })
  }
  const interval = measured(); interval.data!.collected_through = '2026-10-04T10:03:00Z'; invalid.push(interval)
  const reversed = measured(); reversed.data!.collected_through = '2026-10-04T09:59:59Z'; invalid.push(reversed)
  const precision = measured(); precision.data!.collected_from = '2026-10-04T10:00:00.1234567Z'; invalid.push(precision)
  invalid.push({ ...empty, origin: 'https://private.example' }, { ...empty, status: { ...empty.status, stale: false } }, { ...empty, status: { ...empty.status, state: 'failed' } })
  for (const value of invalid) expect(() => parseView(value, clientID, record.id, period)).toThrow(APIError)
})
it('requires canonical UTC seconds, explicit supported currency and a positive half-open period of at most 31 days', () => {
  expect(validPeriod({ start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z', currency: 'KWD' })).toBe(true)
  for (const patch of [{ start: period.end }, { end: period.start }, { start: '2026-02-30T00:00:00Z' }, { end: '2026-11-02T00:00:00Z' }, { start: '1999-12-31T00:00:00Z' }, { start: '2026-10-01T00:00:00.000Z' }, { start: '2026-10-01T00:00:00+00:00' }, { currency: 'CAD' }]) expect(validPeriod({ ...period, ...patch } as typeof period)).toBe(false)
})
it('accepts zero/three-decimal reports only when every section has the same explicit currency exponent', () => {
  for (const [currency, exponent] of [['JPY', 0], ['KWD', 3]] as const) {
    const value = measured()
    for (const section of [value.data!.orders, value.data!.refunds, value.data!.products]) { section.currency = currency; section.currency_exponent = exponent }
    expect(parseView(value, clientID, record.id, { ...period, currency }).data?.orders.currency_exponent).toBe(exponent)
    value.data!.products.currency_exponent = 2
    expect(() => parseView(value, clientID, record.id, { ...period, currency })).toThrow(APIError)
  }
})
it('restricts the catalog to client-bound WooCommerce metadata and reconciles exact revisions', () => {
  expect(parseCatalog({ data: [record], next_id: null }, clientID).data).toEqual([record])
  for (const value of [{ data: [{ ...record, provider: 'ga4' }], next_id: null }, { data: [{ ...record, client_id: otherID }], next_id: null }, { data: [record, record], next_id: null }, { data: [record], next_id: record.id }, { data: [{ ...record, origin: 'https://private.example' }], next_id: null }]) expect(() => parseCatalog(value, clientID)).toThrow(APIError)
  expect(parseQueued({ job_id: otherID, state: 'queued', connection_revision: '9007199254740995' }, 9007199254740995n).state).toBe('queued')
  expect(() => parseQueued({ job_id: otherID, state: 'queued', connection_revision: record.revision }, 9007199254740995n)).toThrow(APIError)
})
it('refuses unsafe origins and writes before transport and permits only validated report deep links', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect(api.validOrigin('https://shop.example.com/wordpress')).toBe(true)
  for (const origin of ['http://shop.example.com', 'https://shop.example.com/', 'https://shop.example.com:443', 'https://secret@shop.example.com', 'https://127.0.0.1', 'https://localhost', 'https://shop.example.com?consumer_key=private', 'https://shop.example.com#private', 'https://shop.example.com/a/../b', 'https://shop.example.com/%2fprivate', 'https://Shop.example.com']) await expect(api.create(clientID, origin)).rejects.toBeInstanceOf(APIError)
  await expect(api.read('../private', record.id, period, new AbortController().signal)).rejects.toBeInstanceOf(APIError)
  await expect(api.queue({ ...record, state: 'revocation_failed' }, period)).rejects.toBeInstanceOf(APIError)
  await expect(api.queue(record, period, { consumer_key: 'ck_' + '0'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) })).rejects.toBeInstanceOf(APIError)
  expect(fetcher).not.toHaveBeenCalled()
  for (const path of [`/app/clients/${clientID}/commerce`, `/app/clients/${clientID}/commerce/${record.id}`]) expect(safeReturnTo(path)).toBe(path)
  expect(safeReturnTo(`/app/clients/${clientID}/commerce/invalid`)).toBe('/app')
})
it('sends credentials once in an authenticated body with explicit currency/period and accepts queued status only', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: otherID, state: 'queued', connection_revision: '9007199254740995' }), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  const credential = { consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) }
  await api.queue(record, period, credential)
  const [url, options] = fetcher.mock.calls[0]!
  expect(url).toBe(`/api/v1/clients/${clientID}/integrations/${record.id}/woocommerce/credentials`)
  expect(JSON.parse(options.body)).toEqual({ revision: record.revision, ...period, ...credential })
  expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-CSRF-Token': 'a'.repeat(43) } })
  expect(fetcher).toHaveBeenCalledOnce()
})
