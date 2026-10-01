import { describe, expect, it, vi } from 'vitest'
import { AuthError, csrfToken, currentSession, login, logout } from './auth-service'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('auth request safety', () => {
  it('distinguishes missing sessions from login failures without exposing server messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(json(401, { error: { code: 'invalid_credentials', message: 'unsafe-test-detail' } }))))
    expect(await currentSession(new AbortController().signal)).toBeNull()
    await expect(login('fixture@example.com', 'synthetic fixture')).rejects.toThrow('Email or password is incorrect.')
  })

  it('never accepts HTML, redirects or malformed success as identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>unsafe test detail</html>', { headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(currentSession(new AbortController().signal)).rejects.toBeInstanceOf(AuthError)
    fetchMock.mockResolvedValue(json(200, { data: {} }))
    await expect(currentSession(new AbortController().signal)).rejects.toThrow('Unable to contact')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store', credentials: 'same-origin' })
  })

  it('reads only the secure CSRF cookie on HTTPS and rejects absent/malformed values', () => {
    vi.stubGlobal('location', { protocol: 'https:' })
    const cookie = vi.spyOn(document, 'cookie', 'get')
    cookie.mockReturnValue(`else_csrf=${'d'.repeat(43)}`)
    expect(() => csrfToken()).toThrow('Request verification failed')
    cookie.mockReturnValue(`else_csrf=${'d'.repeat(43)}; __Host-else_csrf=${'s'.repeat(43)}`)
    expect(csrfToken()).toBe('s'.repeat(43))
    cookie.mockReturnValue('__Host-else_csrf=malformed')
    expect(() => csrfToken()).toThrow('Request verification failed')
  })

  it('maps throttling and CSRF failures to safe actionable messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(429, { error: { code: 'authentication_rate_limited', message: 'unsafe-test-detail' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(login('fixture@example.com', 'synthetic fixture')).rejects.toThrow('Wait 15 minutes')
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(`else_csrf=${'d'.repeat(43)}`)
    fetchMock.mockResolvedValue(json(403, { error: { code: 'csrf_failed' } }))
    await expect(logout()).rejects.toThrow('Request verification failed')
  })
})
