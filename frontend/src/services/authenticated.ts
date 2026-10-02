import { AuthError, csrfToken } from '../features/auth/auth-service'
import { isRecord } from '../features/auth/session'

const messages: Record<string, string> = {
  invalid_schedule: 'Check the local date, named timezone and explicit occurrence. The server timezone rules must agree with the selected offset.',
  invalid_owner: 'Choose an active owner with reminder access for this client, or retain the recorded owner.',
  invalid_resource_link: 'New links require independent access to a nonarchived resource in this client. Retain or clear an existing reference.',
  invalid_transition: 'That status transition is no longer available. Reload the record before choosing a new status.',
  invalid_dates: 'Check the plan date window and its nonarchived milestone due dates.',
  invalid_task_link: 'New links require task access and nonarchived tasks belonging to this client. Retain or remove unavailable existing references.',
  invalid_assignee: 'Choose an active assignee with task access for this client, or clear the assignee.',
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

export class APIError extends Error {
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

// Domain services validate endpoint IDs and query contracts before calling this transport.
export async function authenticatedJSON(
  path: string,
  options: {
    method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    body?: unknown
    signal?: AbortSignal
  } = {},
) {
  if (
    !/^\/api\/v1\/(users|roles|permissions|clients)(?:[/?]|$)/.test(path) ||
    /[\s#\\]/.test(path) ||
    path.includes('..')
  )
    throw new APIError(0, 'invalid_request')
  try {
    const response = await fetch(path, {
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
      throw new APIError(0, 'invalid_response')
    const body: unknown = await response.json()
    if (!response.ok)
      throw new APIError(
        response.status,
        isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
          ? body.error.code
          : 'request_failed',
      )
    return body
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof APIError) throw error
    if (error instanceof AuthError) throw new APIError(error.status, error.code)
    throw new APIError(0, 'service_unavailable')
  }
}
