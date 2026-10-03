import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  canDisable,
  cursorAfter,
  parseConnection,
  parseDisconnect,
  parsePage,
} from './models'
import type { Connection } from './models'

function path(clientID: string, id?: string) {
  if (!isUUID(clientID) || (id !== undefined && !isUUID(id)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${clientID}/integrations${id ? '/' + id : ''}`
}
export async function list(
  clientID: string,
  cursor: string,
  signal: AbortSignal,
) {
  const endpoint = path(clientID)
  const after = cursor ? cursorAfter(cursor, clientID) : ''
  const query = new URLSearchParams({ limit: '25' })
  if (cursor) query.set('cursor', cursor)
  return parsePage(
    await authenticatedJSON(`${endpoint}?${query}`, { signal }),
    clientID,
    after,
  )
}
export async function detail(
  clientID: string,
  id: string,
  signal: AbortSignal,
) {
  return parseConnection(
    await authenticatedJSON(path(clientID, id), { signal }),
    clientID,
    id,
  )
}
export async function disconnect(record: Connection) {
  const endpoint = path(record.client_id, record.id)
  if (!canDisable(record)) throw new APIError(0, 'invalid_request')
  return parseDisconnect(
    await authenticatedJSON(`${endpoint}/disconnect`, {
      method: 'POST',
      body: { revision: record.revision, confirmed: true },
    }),
    record,
  )
}
