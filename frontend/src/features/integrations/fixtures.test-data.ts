import type { Session } from '../auth/session'
import type { Connection } from './models'
export const clientID = 'b0000000-0000-4000-8000-000000000001'
export const actorID = 'b0000000-0000-4000-8000-000000000002'
export const otherID = 'b0000000-0000-4000-8000-000000000003'
export const date = '2026-10-03T12:00:00.123456Z'
export function connection(
  n = 1,
  state: Connection['state'] = 'connected',
): Connection {
  return {
    id: `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    client_id: clientID,
    provider: 'meta_ads',
    state,
    revision: '9007199254740993',
    created_at: date,
    updated_at: date,
  }
}
export const cursor = (id: string, client = clientID) =>
  btoa(`v1|${client}|${id}`)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
export const page = (data: unknown[], next_cursor: string | null = null) => ({
  data,
  page: { limit: 25, next_cursor },
})
export const client = {
  id: clientID,
  name: 'Synthetic integration client',
  legal_name: '',
  website: '',
  notes: '',
  status: 'active',
  revision: 1,
  tags: [],
  contacts: [],
  created_at: date,
  updated_at: date,
  archived_at: null,
}
export const identity: Session = {
  user: {
    id: actorID,
    email: 'integration.fixture@example.com',
    display_name: 'Integration Actor',
    permissions: [
      'clients.view',
      'integrations.view',
      'integrations.manage',
    ].map((permission) => ({
      permission,
      scope: 'client',
      client_id: clientID,
    })),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
