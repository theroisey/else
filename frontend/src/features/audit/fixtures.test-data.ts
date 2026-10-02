import type { Session } from '../auth/session'
import type { Summary, Detail } from './models'
export const clientID = '22222222-2222-4222-8222-222222222222'
export const actorID = '11111111-1111-4111-8111-111111111111'
export const otherID = '33333333-3333-4333-8333-333333333333'
export const date = '2026-10-02T12:00:00.123456Z'
export const requestID = 'AAAAAAAAAAAAAAAAAAAAAAAAAA'
export const identity: Session = {
  user: {
    id: actorID,
    email: 'audit.fixture@example.com',
    display_name: 'Synthetic Audit Reader',
    permissions: [
      { permission: 'audit.view', scope: 'global' },
      { permission: 'clients.view', scope: 'client', client_id: clientID },
    ],
  },
  session: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
}
export function event(n = 1, delta: Partial<Summary> = {}): Summary {
  return {
    id: `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    schema_version: 1,
    occurred_at: date,
    actor_kind: 'user',
    actor_user_id: actorID,
    event_type: 'task.updated',
    resource_kind: 'task',
    resource_id: otherID,
    client_id: clientID,
    request_id: requestID,
    ...delta,
  }
}
export const detail = (row = event()): Detail => ({
  ...row,
  before_state: { revision: '9007199254740992', task_status: 'todo' },
  after_state: { revision: '9223372036854775807', task_status: 'done' },
  metadata: { source: 'http' },
})
export const page = (data: unknown[], next: string | null = null) => ({
  data,
  page: { limit: 25, next_cursor: next },
})
