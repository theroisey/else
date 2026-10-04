import { clientID, connection, date } from '../integrations/fixtures.test-data'
import type { Workspace, View } from './models'
export { clientID, otherID, identity, client } from '../integrations/fixtures.test-data'
export const record = { ...connection(), provider: 'ga4' as const }
export const period = { since: '2026-10-01', until: '2026-10-03' }
const base = { client_id: clientID, connection_id: record.id, api_version: 'v1beta' as const, timezone: 'Europe/Istanbul', ...period, metrics: ['activeUsers', 'sessions', 'screenPageViews', 'keyEvents'] }
const metrics = ['9007199254740993', '12', '18', '1.3333333333333333']
export function workspace(): Workspace {
  return {
    definitions: base.metrics.map((name, i) => ({ name: name as Workspace['definitions'][number]['name'], type: i === 3 ? 'TYPE_FLOAT' : 'TYPE_INTEGER', display_name: ['Active users', 'Sessions', 'Views', 'Key events'][i]!, description: 'Synthetic selected metric definition.' })),
    summary: { ...base, dimensions: [], rows: [{ dimensions: [], metrics }] },
    daily: { ...base, dimensions: ['date'], rows: [{ dimensions: ['20261001'], metrics }] },
    acquisition: { ...base, dimensions: ['date', 'sessionDefaultChannelGroup'], rows: [{ dimensions: ['20261001', 'Organic Search'], metrics }] },
    devices: { ...base, dimensions: ['date', 'deviceCategory'], rows: [{ dimensions: ['20261001', 'desktop'], metrics }] },
    landing: { ...base, dimensions: ['landingPage'], rows: [{ dimensions: ['/synthetic'], metrics }] },
  }
}
export function measured(): View {
  return { status: { state: 'succeeded', job_id: 'c0000000-0000-4000-8000-000000000001', reason: null, updated_at: date, synced_at: date, stale: false }, data: workspace() }
}
export const empty: View = { status: { state: 'not_synced', job_id: null, reason: null, updated_at: null, synced_at: null, stale: true }, data: null }
