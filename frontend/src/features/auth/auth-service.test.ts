import { isAccountEmail } from './email'
import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  csrfToken,
  currentSession,
  verifyCode,
  requestCode,
  logout,
} from './auth-service'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('auth request safety', () => {
  it('distinguishes missing sessions from login failures without exposing server messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          json(401, {
            error: { code: 'invalid_code', message: 'unsafe-test-detail' },
          }),
        ),
      ),
    )
    expect(await currentSession(new AbortController().signal)).toBeNull()
    await expect(
      verifyCode('fixture@example.com', 'synthetic fixture'),
    ).rejects.toThrow(
      'The code is incorrect or no longer available. Request a new code if needed.',
    )
  })

  it('never accepts HTML, redirects or malformed success as identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html>unsafe test detail</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      currentSession(new AbortController().signal),
    ).rejects.toBeInstanceOf(AuthError)
    fetchMock.mockResolvedValue(json(200, { data: {} }))
    await expect(currentSession(new AbortController().signal)).rejects.toThrow(
      'Unable to contact',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      credentials: 'same-origin',
    })
  })

  it('reads only the secure CSRF cookie on HTTPS and rejects absent/malformed values', () => {
    const environment = (
      globalThis as unknown as {
        jsdom: { reconfigure(options: { url: string }): void }
      }
    ).jsdom
    environment.reconfigure({ url: 'https://localhost:3000' })
    const cookie = vi.spyOn(document, 'cookie', 'get')
    cookie.mockReturnValue(`else_csrf=${'d'.repeat(43)}`)
    expect(() => csrfToken()).toThrow('Request verification failed')
    cookie.mockReturnValue(
      `else_csrf=${'d'.repeat(43)}; __Host-else_csrf=${'s'.repeat(43)}`,
    )
    expect(csrfToken()).toBe('s'.repeat(43))
    cookie.mockReturnValue('__Host-else_csrf=malformed')
    expect(() => csrfToken()).toThrow('Request verification failed')
    environment.reconfigure({ url: 'http://localhost:3000' })
  })

  it('maps throttling and CSRF failures to safe actionable messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(429, {
        error: {
          code: 'authentication_rate_limited',
          message: 'unsafe-test-detail',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      verifyCode('fixture@example.com', 'synthetic fixture'),
    ).rejects.toThrow('Wait before')
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      `else_csrf=${'d'.repeat(43)}`,
    )
    fetchMock.mockResolvedValue(json(403, { error: { code: 'csrf_failed' } }))
    await expect(logout()).rejects.toThrow('Request verification failed')
  })
})

it('keeps anonymous challenges separate from authenticated identities and validates timing bounds', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    json(202, {
      data: {
        challenge_id: 'a'.repeat(43),
        expires_in: 180,
        resend_after: 60,
      },
    }),
  )
  vi.stubGlobal('fetch', fetcher)
  expect(await requestCode('fixture@example.com')).toEqual({
    challenge_id: 'a'.repeat(43),
    expires_in: 180,
    resend_after: 60,
  })
  fetcher.mockResolvedValue(
    json(200, {
      data: { challenge_id: 'a'.repeat(43), expires_in: 900, resend_after: 60 },
    }),
  )
  await expect(requestCode('fixture@example.com')).rejects.toBeInstanceOf(
    AuthError,
  )
  fetcher.mockResolvedValue(json(200, { data: { user: {} } }))
  await expect(requestCode('fixture@example.com')).rejects.toBeInstanceOf(
    AuthError,
  )
})

it('validates identity email syntax before requesting mail', () => {
  for (const email of [
    '@example.com',
    '.start@example.com',
    'end.@example.com',
    'double..dot@example.com',
    `${'x'.repeat(65)}@example.com`,
  ])
    expect(isAccountEmail(email)).toBe(false)
  expect(isAccountEmail(' Member+Tag@Example.com ')).toBe(true)
})
