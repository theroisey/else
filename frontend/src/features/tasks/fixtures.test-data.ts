import type { Task } from './models'
import type { Session } from '../auth/session'
export const clientID = '11111111-1111-4111-8111-111111111111'
export const taskID = '22222222-2222-4222-8222-222222222222'
export const actorID = '33333333-3333-4333-8333-333333333333'
export const otherID = '44444444-4444-4444-8444-444444444444'
export const date = '2026-10-01T00:00:00Z'
export const task: Task = {
  id: taskID,
  client_id: clientID,
  created_by: actorID,
  assignee_id: null,
  title: 'Task Fixture',
  description: 'Private fixture description\nSecond line',
  status: 'todo',
  priority: 'medium',
  start_at: null,
  due_at: null,
  completed_at: null,
  cancelled_at: null,
  revision: 1,
  tags: ['fixture'],
  created_at: date,
  updated_at: date,
  archived_at: null,
}
export const identity: Session = {
  user: {
    id: actorID,
    email: 'task.actor@example.com',
    display_name: 'Task Actor',
    permissions: ['tasks.view', 'tasks.create', 'tasks.update', 'tasks.delete'].map(
      (permission) => ({ permission, scope: 'client', client_id: clientID }),
    ),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
