import { isRecord, parseSession } from './session'

export class AuthError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(status === 401 && code === 'invalid_credentials' ? 'Email or password is incorrect.'
      : status === 429 ? 'Too many sign-in attempts. Wait 15 minutes before trying again.'
        : status === 403 ? 'Request verification failed. Reload this page and try again.'
          : 'Unable to contact the sign-in service. Try again.')
  }
}

type AuthPath = '/api/v1/auth/session' | '/api/v1/auth/login' | '/api/v1/auth/logout'

// Credentials stay in the browser cookie jar. Never accept arbitrary URLs here.
async function authRequest(path: AuthPath, init: RequestInit = {}) {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json', ...init.headers },
    })
    if (response.status === 204 && path === '/api/v1/auth/logout') return null
    if (response.ok && path === '/api/v1/auth/logout') throw new AuthError(0, 'invalid_response')
    if (response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new AuthError(0, 'invalid_response')
    }
    const body: unknown = await response.json()
    if (!response.ok) {
      const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : 'request_failed'
      throw new AuthError(response.status, code)
    }
    return parseSession(body)
  } catch (error) {
    if (init.signal?.aborted) throw error
    if (error instanceof AuthError) throw error
    throw new AuthError(0, 'service_unavailable')
  }
}

export async function currentSession(signal: AbortSignal) {
  try {
    const session = await authRequest('/api/v1/auth/session', { signal })
    return session && Date.parse(session.session.expires_at) > Date.now() ? session : null
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return null
    throw error
  }
}

export async function login(email: string, password: string) {
  const session = await authRequest('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  if (!session || Date.parse(session.session.expires_at) <= Date.now()) throw new AuthError(0, 'invalid_response')
  return session
}

export function csrfToken() {
  // Production never falls back to an unprefixed development cookie.
  const name = location.protocol === 'https:' ? '__Host-else_csrf' : 'else_csrf'
  const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError(403, 'csrf_failed')
  return value
}

export async function logout() {
  try {
    await authRequest('/api/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }, body: '{}' })
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) return
    throw error
  }
}
