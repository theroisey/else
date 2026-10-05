import { afterEach, expect, it, vi } from 'vitest'
import * as api from './service'
const client = '11111111-1111-4111-8111-111111111111',
  website = '22222222-2222-4222-8222-222222222222',
  other = '33333333-3333-4333-8333-333333333333'
const record: api.Website = {
  id: website,
  client_id: client,
  name: 'Clients',
  url: 'https://shop.example.com/catalog',
  domain: 'shop.example.com',
  description: 'Synthetic user content',
  status: 'active',
  is_primary: false,
  needs_review: false,
  revision: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  archived_at: null,
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
  vi.unstubAllGlobals()
})
it('retains user names, URL paths and descriptions exactly', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: record })))
  expect(await api.detail(client, website)).toEqual(record)
})
it.each([
  { ...record, client_id: other },
  { ...record, id: other },
  {
    ...record,
    status: 'archived',
    is_primary: true,
    archived_at: '2026-10-01T00:00:00Z',
  },
])(
  'rejects wrong ownership, identity and impossible primary state',
  async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: value })))
    await expect(api.detail(client, website)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  },
)
it('bounds cursors and rejects invalid identifiers before issuing requests', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(
    api.connections(
      client,
      website,
      'not-a-cursor',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(
    api.activity(client, website, 'not-a-cursor', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(api.detail(client, 'not-a-website')).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(() => api.websiteBase(client, 'not-a-website')).toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('sends a revision, explicit confirmation and CSRF for primary and archive commands', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(json({ data: { id: website, revision: 2 } })),
    )
  vi.stubGlobal('fetch', fetcher)
  await api.action(record, 'primary')
  await api.action(record, 'archive')
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toMatch(/\/(primary|archive)$/)
    expect(options).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: '{"expected_revision":1,"confirm":true}',
      headers: { 'X-CSRF-Token': 'a'.repeat(43) },
    })
  }
})
it('rejects an uncertain mutation response and performs no automatic retry', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockResolvedValue(json({ data: { id: website, revision: 9 } }))
  vi.stubGlobal('fetch', fetcher)
  await expect(api.bind(record, other, true)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('rejects another website’s activity', async () => {
  const page = { limit: 25, next_cursor: null }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        data: [
          {
            id: other,
            client_id: client,
            resource_id: other,
            resource_kind: 'website',
            event_type: 'website.created',
            occurred_at: record.created_at,
            summary: 'Website created.',
          },
        ],
        page,
      }),
    ),
  )
  await expect(
    api.activity(client, website, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})

it('rejects a connection owned by another client before rendering it', async () => {
  const connection = {
    id: other,
    client_id: other,
    provider: 'ga4',
    state: 'pending',
    revision: '1',
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json({ data: [connection], page: { limit: 25, next_cursor: null } }),
      ),
  )
  await expect(
    api.connections(client, website, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
