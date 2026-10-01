import { AuthError, csrfToken } from '../auth/auth-service'
import { isRecord, isUUID } from '../auth/session'
import { parseAssignment, parseCatalog, parsePage, parseRole, parseUser } from './models'

const messages: Record<string, string> = {
  conflict:
    'The record changed or conflicts with an existing record. Reload current data before trying again.',
  last_administrator: 'At least one active administrator must remain.',
  self_disable: 'You cannot disable your own account.',
  system_role: 'Built-in roles are read only.',
  permission_denied: 'Your permissions do not allow this operation.',
  authentication_required: 'Your session ended. Sign in again.',
  invalid_request: 'Check the form values and try again.',
  csrf_failed: 'Request verification failed. Reload the page and try again.',
  origin_forbidden: 'Request verification failed. Reload the page and try again.',
  not_found: 'The record is no longer available.',
}
export class AdministrationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      Object.hasOwn(messages, code)
        ? messages[code]
        : 'Unable to complete this request. Try again.',
    )
  }
}
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
  try {
    const response = await fetch(`/api/v1${path}${query}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: options.method
        ? {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken(),
          }
        : { Accept: 'application/json' },
      body: options.method ? JSON.stringify(options.body ?? {}) : null,
    })
    if (response.status === 204 && options.method === 'DELETE') return null
    if (
      response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new AdministrationError(0, 'invalid_response')
    const body: unknown = await response.json()
    if (!response.ok)
      throw new AdministrationError(
        response.status,
        isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
          ? body.error.code
          : 'request_failed',
      )
    if (options.method) {
      if (!isRecord(body) || !isRecord(body.data) || !isUUID(body.data.id))
        throw new AdministrationError(0, 'invalid_response')
      return { id: body.data.id }
    }
    return body
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof AdministrationError) throw error
    if (error instanceof AuthError) throw new AdministrationError(error.status, error.code)
    throw new AdministrationError(0, 'service_unavailable')
  }
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
