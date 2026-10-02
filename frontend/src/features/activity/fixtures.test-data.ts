import type { Session } from '../auth/session'
import { kindLabels } from './models'
import type { ActivityEvent, eventTypes } from './models'
export const clientID = 'e0000000-0000-4000-8000-000000000001'
export const actorID = 'e0000000-0000-4000-8000-000000000002'
export const otherID = 'e0000000-0000-4000-8000-000000000003'
export const date = '2026-10-02T12:00:00.123456Z'
export function event(
  n = 1,
  type: (typeof eventTypes)[number] = 'task.updated',
  time = date,
): ActivityEvent {
  const [kind, action] = type.split('.') as [ActivityEvent['resource_kind'], string]
  return {
    id: `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    client_id: clientID,
    occurred_at: time,
    event_type: type,
    resource_kind: kind,
    resource_id:
      kind === 'client' ? clientID : `e2000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    summary: `${kindLabels[kind]} ${action}.`,
  }
}
export const page = (data: unknown[], next_cursor: string | null = null) => ({
  data,
  page: { limit: 25, next_cursor },
})
export const identity: Session = {
  user: {
    id: actorID,
    email: 'activity.fixture@example.com',
    display_name: 'Activity Actor',
    permissions: [
      'clients.view',
      'activity.view',
      'tasks.view',
      'planning.view',
      'reminders.view',
    ].map((permission) => ({ permission, scope: 'client', client_id: clientID })),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
