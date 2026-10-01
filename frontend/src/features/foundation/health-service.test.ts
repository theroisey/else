import { describe, expect, it, vi } from 'vitest'
import { checkService } from './health-service'

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
})

describe('public service contract', () => {
  it('uses only same-origin health paths and passes cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    expect(await checkService('backend', controller.signal)).toBe('available')
    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/health')
    expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(options.signal?.aborted).toBe(false)
    controller.abort()
    expect(options.signal?.aborted).toBe(true)
  })

  it('preserves real 503 readiness as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'not_ready', message: 'Service is not ready.', request_id: 'test-request' },
    }, 503)))
    expect(await checkService('readiness', new AbortController().signal)).toBe('unavailable')
  })

  it('accepts only the documented readiness success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' })))
    expect(await checkService('readiness', new AbortController().signal)).toBe('available')
  })

  it.each([
    ['wrong status', jsonResponse({ status: 'ok' }, 500)],
    ['wrong success shape', jsonResponse({ status: 'ready' })],
    ['null body', jsonResponse(null)],
    ['wrong content type', new Response('<html>secret-test-value</html>')],
    ['non-JSON media type prefix', new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/jsonp' } })],
    ['malformed JSON', new Response('secret-test-value', { headers: { 'Content-Type': 'application/json' } })],
  ])('rejects %s without disclosing response content', async (_name, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(checkService('backend', new AbortController().signal)).rejects.toThrow('Service check failed. Try again.')
  })

  it('rejects malformed 503 rather than pretending readiness was checked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'secret-test-value' }, 503)))
    await expect(checkService('readiness', new AbortController().signal)).rejects.toThrow('Service check failed. Try again.')
  })

  it('redacts network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-test-value')))
    await expect(checkService('backend', new AbortController().signal)).rejects.toThrow('Service check failed. Try again.')
  })
})
