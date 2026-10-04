import { clientID, connection, date } from '../integrations/fixtures.test-data'
import type { Period, View, Workspace } from './models'
export { clientID, otherID, identity, client } from '../integrations/fixtures.test-data'
export const record = { ...connection(), provider: 'woocommerce' as const }
export const period: Period = { start: '2026-10-01T00:00:00Z', end: '2026-10-04T00:00:00Z', currency: 'USD' }
export function workspace(): Workspace {
  const binding = { client_id: clientID, connection_id: record.id, api_version: 'wc/v3' as const, currency: period.currency, currency_exponent: 2, start: period.start, end: period.end }
  return {
    orders: { ...binding, orders: [{ id: '9007199254740993', status: 'pending', created_at: period.start, grand_total_minor: '9007199254740993', lifetime_refund_minor: '1', remainder_minor: '9007199254740992' }], grand_total_minor: '9007199254740993', lifetime_refund_minor: '1', remainder_minor: '9007199254740992' },
    refunds: { ...binding, refunds: [{ id: '9007199254740994', parent_id: '1', created_at: '2026-10-03T12:00:00Z', amount_minor: '123' }], amount_minor: '123' },
    products: { ...binding, products: [{ product_id: '0', variation_id: '0', quantity: '9007199254740993', order_count: '1', line_count: '1', total_minor: '9007199254740993', tax_minor: '1', line_grand_minor: '9007199254740994' }] },
    collected_from: '2026-10-04T10:00:00.123456Z', collected_through: '2026-10-04T10:00:01Z',
  }
}
export function measured(): View {
  return { status: { state: 'succeeded', job_id: 'c0000000-0000-4000-8000-000000000001', reason: null, updated_at: date, synced_at: date, stale: false }, data: workspace() }
}
export const empty: View = { status: { state: 'not_synced', job_id: null, reason: null, updated_at: null, synced_at: null, stale: true }, data: null }
