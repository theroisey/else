import { isRecord, parseSession } from './session'

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(
      status === 401 && code === 'invalid_code'
        ? 'The code is incorrect or no longer available. Request a new code if needed.'
        : status === 429
          ? 'Too many attempts. Wait before requesting or verifying another code.'
          : status === 403
            ? 'Request verification failed. Reload this page and try again.'
            : 'Unable to contact the sign-in service. Try again.',
    )
  }
}

type AuthPath =
  | '/api/v1/auth/session'
  | '/api/v1/auth/otp/request'
  | '/api/v1/auth/otp/verify'
  | '/api/v1/auth/logout'
  | '/api/v1/auth/refresh'

// Credentials stay in the browser cookie jar. Never accept arbitrary URLs here.
async function authDocument(
  path: AuthPath,
  init: RequestInit = {},
): Promise<unknown> {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', ...init.headers },
    })
    if (response.status === 204 && path === '/api/v1/auth/logout') return null
    if (response.ok && path === '/api/v1/auth/logout')
      throw new AuthError(0, 'invalid_response')
    if (
      response.headers
        .get('Content-Type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() !== 'application/json'
    ) {
      throw new AuthError(0, 'invalid_response')
    }
    const body: unknown = await response.json()
    if (!response.ok) {
      const code =
        isRecord(body) &&
        isRecord(body.error) &&
        typeof body.error.code === 'string'
          ? body.error.code
          : 'request_failed'
      throw new AuthError(response.status, code)
    }
    return body
  } catch (error) {
    if (init.signal?.aborted) throw error
    if (error instanceof AuthError) throw error
    throw new AuthError(0, 'service_unavailable')
  }
}

async function authRequest(path: AuthPath, init: RequestInit = {}) {
  const body = await authDocument(path, init)
  try {
    return body === null ? null : parseSession(body)
  } catch {
    throw new AuthError(0, 'invalid_response')
  }
}

export interface OtpChallenge {
  challenge_id: string
  expires_in: number
  resend_after: number
}
function parseChallenge(body: unknown): OtpChallenge {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isRecord(body.data))
    throw new AuthError(0, 'invalid_response')
  const value = body.data
  if (
    Object.keys(value).sort().join(',') !==
      'challenge_id,expires_in,resend_after' ||
    typeof value.challenge_id !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.challenge_id) ||
    !Number.isSafeInteger(value.expires_in) ||
    Number(value.expires_in) < 60 ||
    Number(value.expires_in) > 300 ||
    !Number.isSafeInteger(value.resend_after) ||
    Number(value.resend_after) < 30 ||
    Number(value.resend_after) > 180
  )
    throw new AuthError(0, 'invalid_response')
  return value as unknown as OtpChallenge
}
export function requestCode(email: string) {
  return authLock(async () =>
    parseChallenge(
      await authDocument('/api/v1/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    ),
  )
}

// Opaque credentials remain in HttpOnly cookies. The queue and Web Lock prevent
// sibling tabs from submitting the same one-use refresh generation concurrently.
let authQueue: Promise<unknown> = Promise.resolve()
function authLock<T>(action: () => Promise<T>): Promise<T> {
  const run = authQueue
    .catch(() => undefined)
    .then(() =>
      navigator.locks
        ? navigator.locks.request('roisey-else.auth', action)
        : action(),
    )
  authQueue = run.catch(() => undefined)
  return run
}
async function readSession(signal?: AbortSignal) {
  try {
    const session = await authRequest(
      '/api/v1/auth/session',
      signal ? { signal } : {},
    )
    return session && Date.parse(session.session.expires_at) > Date.now()
      ? session
      : null
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return null
    throw error
  }
}
let renewal: Promise<Awaited<ReturnType<typeof readSession>>> | undefined
export async function currentSession(signal: AbortSignal) {
  const current = await readSession(signal)
  if (current && Date.parse(current.session.expires_at) - Date.now() > 300_000)
    return current
  try {
    csrfToken()
  } catch {
    return current
  }
  renewal ??= authLock(async () => {
    const latest = await readSession()
    if (latest && Date.parse(latest.session.expires_at) - Date.now() > 300_000)
      return latest
    try {
      const renewed = await authRequest('/api/v1/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken(),
        },
        body: '{}',
      })
      if (!renewed || Date.parse(renewed.session.expires_at) <= Date.now())
        throw new AuthError(0, 'invalid_response')
      return renewed
    } catch (error) {
      // Legacy sessions have no refresh family. Preserve their remaining access.
      if (
        error instanceof AuthError &&
        (error.status === 401 || error.status === 403)
      )
        return readSession()
      throw error
    }
  }).finally(() => {
    renewal = undefined
  })
  const result = await renewal
  signal.throwIfAborted()
  return result
}

export function verifyCode(challenge_id: string, code: string) {
  return authLock(async () => {
    const session = await authRequest('/api/v1/auth/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id, code }),
    })
    if (!session || Date.parse(session.session.expires_at) <= Date.now())
      throw new AuthError(0, 'invalid_response')
    return session
  })
}

export function csrfToken() {
  // Production never falls back to an unprefixed development cookie.
  const name = location.protocol === 'https:' ? '__Host-else_csrf' : 'else_csrf'
  const value = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new AuthError(403, 'csrf_failed')
  return value
}

export function logout() {
  return authLock(async () => {
    try {
      await authRequest('/api/v1/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken(),
        },
        body: '{}',
      })
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) return
      throw error
    }
  })
}
