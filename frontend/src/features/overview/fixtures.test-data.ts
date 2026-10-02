import type { Overview, DueTask, DueReminder } from './models'
import type { Session } from '../auth/session'
import type { ActivityEvent } from '../activity/models'
export const clientID = 'a5555555-5555-4555-8555-555555555555',
  otherID = 'b5555555-5555-4555-8555-555555555555',
  actorID = 'a1111111-1111-4111-8111-111111111111'
export const date = '2026-10-02T12:00:00.123456Z',
  horizon = '2026-10-09T12:00:00.123456Z'
export const identity: Session = {
  user: {
    id: actorID,
    email: 'overview.fixture@example.com',
    display_name: 'Overview Fixture',
    permissions: [
      'clients.view',
      'billing.view',
      'tasks.view',
      'reminders.view',
      'activity.view',
      'planning.view',
      'pricing.view',
    ].map((permission) => ({
      permission,
      scope: 'client',
      client_id: clientID,
    })),
  },
  session: { expires_at: new Date(Date.now() + 3600000).toISOString() },
}
export function task(i = 1, due_at = '2026-10-01T12:00:00Z'): DueTask {
  return {
    id: `e1000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Synthetic task ${i}`,
    status: 'todo',
    priority: 'urgent',
    due_at,
  }
}
export function reminder(
  i = 1,
  scheduled_at = '2026-10-01T12:00:00Z',
): DueReminder {
  return {
    id: `e2000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    title: `Synthetic reminder ${i}`,
    scheduled_at,
    timezone: 'Europe/Istanbul',
  }
}
export function event(
  i = 1,
  kind: ActivityEvent['resource_kind'] = 'client',
): ActivityEvent {
  return {
    id: `e3000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    client_id: clientID,
    occurred_at: date,
    event_type: `${kind}.created` as ActivityEvent['event_type'],
    resource_kind: kind,
    resource_id: kind === 'client' ? clientID : task().id,
    summary: `${kind === 'client' ? 'Client' : kind === 'task' ? 'Task' : kind === 'plan' ? 'Plan' : kind === 'milestone' ? 'Milestone' : 'Reminder'} created.`,
  }
}
export function overview(): Overview {
  return {
    client: {
      id: clientID,
      name: 'Synthetic overview client',
      status: 'active',
      archived_at: null,
    },
    as_of: date,
    horizon_end: horizon,
    finance: {
      currencies: [
        {
          currency: 'USD',
          currency_exponent: 2,
          amount_minor: '1000',
          paid_minor: '250',
          outstanding_minor: '750',
          overdue_minor: '750',
          cancelled_amount_minor: '200',
          cancelled_paid_minor: '50',
        },
      ],
    },
    tasks: {
      overdue: { items: [task()], has_more: false },
      due_soon: { items: [task(2, '2026-10-03T12:00:00Z')], has_more: false },
    },
    reminders: {
      due: { items: [reminder()], has_more: false },
      upcoming: {
        items: [reminder(2, '2026-10-03T12:00:00Z')],
        has_more: false,
      },
    },
    activity: { items: [event()], has_more: false },
  }
}
