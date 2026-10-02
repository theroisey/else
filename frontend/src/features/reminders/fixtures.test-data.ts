import type { RecordData } from './models'
import type { Session } from '../auth/session'
export {
  clientID,
  actorID,
  taskID,
  otherID,
  planID,
  milestoneID,
} from '../planning/fixtures.test-data'
import { clientID, actorID, otherID } from '../planning/fixtures.test-data'
export const recordID = otherID,
  date = '2026-10-02T00:00:00Z'
export const reminder: RecordData = {
  id: recordID,
  client_id: clientID,
  created_by: actorID,
  owner_id: actorID,
  title: 'Reminder Fixture',
  description: 'Synthetic private reminder text',
  status: 'pending',
  scheduled_at: '2026-11-01T06:30:00.123456Z',
  scheduled_local: '2026-11-01T01:30:00.123456',
  timezone: 'America/New_York',
  utc_offset_seconds: -18000,
  resource: null,
  is_due: false,
  completed_at: null,
  dismissed_at: null,
  revision: 1,
  created_at: date,
  updated_at: date,
}
export const identity: Session = {
  user: {
    id: actorID,
    email: 'reminder.actor@example.com',
    display_name: 'Reminder Actor',
    permissions: ['reminders.view', 'reminders.create', 'reminders.update'].map((permission) => ({
      permission,
      scope: 'client',
      client_id: clientID,
    })),
  },
  session: { expires_at: new Date(Date.now() + 43_200_000).toISOString() },
}
