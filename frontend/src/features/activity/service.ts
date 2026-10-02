import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { cursorSchema, parsePage } from './models'

export async function list(clientID: string, cursor: string, signal: AbortSignal) {
  if (!isUUID(clientID) || (cursor && !cursorSchema.safeParse(cursor).success))
    throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({ limit: '25' })
  if (cursor) query.set('cursor', cursor)
  const page = parsePage(
    await authenticatedJSON(`/api/v1/clients/${clientID}/activity?${query}`, { signal }),
  )
  if (
    page.data.some((event) => event.client_id !== clientID.toLowerCase()) ||
    (cursor && page.page.next_cursor === cursor)
  )
    throw new APIError(0, 'invalid_response')
  return page
}
