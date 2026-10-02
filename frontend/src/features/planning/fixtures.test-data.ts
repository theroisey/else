import type { RecordData } from './models'
import type { Session } from '../auth/session'
export const clientID = '11111111-1111-4111-8111-111111111111',
  planID = '22222222-2222-4222-8222-222222222222',
  milestoneID = '33333333-3333-4333-8333-333333333333',
  actorID = '44444444-4444-4444-8444-444444444444',
  taskID = '55555555-5555-4555-8555-555555555555',
  otherID = '66666666-6666-4666-8666-666666666666'
export const date = '2026-10-02T00:00:00Z'
export const plan: RecordData = {
  id: planID,
  client_id: clientID,
  created_by: actorID,
  title: 'Plan Fixture',
  description: 'Synthetic private plan text',
  status: 'draft',
  start_at: null,
  due_at: null,
  completed_at: null,
  cancelled_at: null,
  revision: 1,
  created_at: date,
  updated_at: date,
  archived_at: null,
}
export const milestone: RecordData = {
  ...plan,
  id: milestoneID,
  plan_id: planID,
  title: 'Milestone Fixture',
  status: 'planned',
  task_ids: [taskID],
}
export const identity: Session = {
  user: {
    id: actorID,
    email: 'planning.actor@example.com',
    display_name: 'Planning Actor',
    permissions: ['planning.view', 'planning.create', 'planning.update', 'planning.archive'].map(
      (permission) => ({ permission, scope: 'client', client_id: clientID }),
    ),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
