import type { Connection } from '../integrations/models'
import { clientID, otherID, client, identity, record as commerceRecord } from '../ecommerce/fixtures.test-data'
import type { View } from './models'
export { clientID, otherID, client, identity }
export const record: Connection = { ...commerceRecord, provider: 'meta_ads' }
export const period = { since: '2026-10-01', until: '2026-10-03' }
export const empty: View = { status: { job_id: null, state: 'not_synced', reason: null, updated_at: null, synced_at: null, stale: true }, data: null }
export function measured(): View {
  return { status: { job_id: otherID, state: 'succeeded', reason: null, updated_at: client.updated_at, synced_at: client.updated_at, stale: false }, data: {
    collected_from: '2026-10-04T10:00:00.123456Z', collected_through: '2026-10-04T10:00:01Z', report: {
      client_id: clientID, connection_id: record.id, graph_version: 'v26.0', currency: 'USD', timezone: 'America/New_York', ...period, attribution_status: 'unavailable',
      days: [
        { date: '2026-10-01', spend_decimal: '1', impressions: '100', clicks: '1', ctr_percent: '1.000000', cpc_decimal: '1.000000', cpm_decimal: '10.000000' },
        { date: '2026-10-03', spend_decimal: '2', impressions: '1', clicks: '1', ctr_percent: '100.000000', cpc_decimal: '2.000000', cpm_decimal: '2000.000000' },
      ], totals: { spend_decimal: '3', impressions: '101', clicks: '2', ctr_percent: '1.980198', cpc_decimal: '1.500000', cpm_decimal: '29.702970' },
    },
  } }
}
