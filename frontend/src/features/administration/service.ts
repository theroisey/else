import { authenticatedJSON, APIError as AdministrationError } from '../../services/authenticated'
import { isRecord, isUUID } from '../auth/session'
import { parseAssignment, parseCatalog, parsePage, parseRole, parseUser } from './models'
export { AdministrationError }
type Endpoint = '/users' | '/roles' | '/permissions' | `/users/${string}` | `/roles/${string}`
export async function request(
  path: Endpoint,
  options: {
    method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    body?: unknown
    signal?: AbortSignal
    cursor?: string
  } = {},
) {
  // No arbitrary hosts, credentials in URLs, or caller-controlled actor fields.
  if (
    !/^\/(users|roles)(\/[0-9a-f-]{36}(\/(disable|permissions|roles)(\/[0-9a-f-]{36})?)?)?$/.test(
      path,
    ) &&
    path !== '/permissions'
  )
    throw new AdministrationError(0, 'invalid_request')
  if (options.cursor && !isUUID(options.cursor)) throw new AdministrationError(0, 'invalid_request')
  const collection =
    path === '/users' || path === '/roles' || /^\/users\/[0-9a-f-]{36}\/roles$/.test(path)
  const query =
    options.method || !collection
      ? ''
      : `?limit=25${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''}`
  const body = await authenticatedJSON(`/api/v1${path}${query}`, options)
  if (body === null && options.method === 'DELETE') return null
  if (options.method) {
    if (!isRecord(body) || !isRecord(body.data) || !isUUID(body.data.id))
      throw new AdministrationError(0, 'invalid_response')
    return { id: body.data.id }
  }
  return body
}
export const users = (signal: AbortSignal, cursor: string) =>
  request('/users', { signal, cursor }).then((b) => parsePage(b, parseUser))
export const roles = (signal: AbortSignal, cursor: string) =>
  request('/roles', { signal, cursor }).then((b) => parsePage(b, parseRole))
export const assignments = (id: string, signal: AbortSignal, cursor: string) =>
  request(`/users/${id}/roles`, { signal, cursor }).then((b) => parsePage(b, parseAssignment))
export const catalog = (signal: AbortSignal) =>
  request('/permissions', { signal }).then(parseCatalog)
export const role = (id: string, signal: AbortSignal) =>
  request(`/roles/${id}`, { signal }).then((b) => {
    if (!isRecord(b)) throw new AdministrationError(0, 'invalid_response')
    return parseRole(b.data)
  })
