import { APIError, authenticatedJSON } from '../../services/authenticated'
import { hasPermission } from '../auth/permissions'
import { isUUID } from '../auth/session'
import type { Grant } from '../auth/session'
import { activityPermissions } from '../activity/permissions'
import { parseOverview } from './models'
import type { Overview } from './models'

export async function read(
  client: string,
  grants: readonly Grant[],
  signal: AbortSignal,
): Promise<Overview> {
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID: client })
  if (!isUUID(client)) throw new APIError(0, 'invalid_request')
  if (!has('clients.view')) throw new APIError(403, 'permission_denied')
  const value = parseOverview(
    await authenticatedJSON(`/api/v1/clients/${client}/overview`, { signal }),
    client,
  )
  const { finance, tasks, reminders, activity, ...context } = value
  const result: Overview = context
  if (has('billing.view') && finance) result.finance = finance
  if (has('tasks.view') && tasks) result.tasks = tasks
  if (has('reminders.view') && reminders) result.reminders = reminders
  if (has('activity.view') && activity) {
    const items = activity.items.filter(
      activityPermissions(grants, client).allows,
    )
    result.activity = {
      items,
      has_more: activity.has_more && items.length === activity.items.length,
    }
  }
  return result
}
