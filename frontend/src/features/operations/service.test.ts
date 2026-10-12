import { it, expect, vi } from 'vitest'
import { todaySchema, detailSchema } from './models'
import { emptyToday } from './fixtures.test-data'
import * as api from './service'
const client = '11111111-1111-4111-8111-111111111111',
  id = '22222222-2222-4222-8222-222222222222',
  other = '33333333-3333-4333-8333-333333333333',
  at = '2026-10-11T12:00:00.000000Z'
const detail = {
  id,
  client_id: client,
  website_id: null,
  created_by: other,
  title: 'Synthetic technical request',
  category: 'bug',
  priority: 'normal',
  status: 'new',
  assignee_id: null,
  task_id: null,
  due_at: null,
  revision: '1',
  delivery_count: 0,
  created_at: at,
  updated_at: at,
  brand_name: 'Synthetic brand',
  website_name: null,
  website_domain: null,
  requester_name: 'Synthetic requester',
  assignee_name: null,
  description: 'A reproducible synthetic issue.',
  reference_url: '',
  deliveries: [],
  reviews: [],
  evidence: [],
  actions: ['comment'],
}
function respond(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}
it('accepts an employee snapshot without any finance field and rejects approximate counts', () => {
  expect(todaySchema.safeParse(emptyToday).success).toBe(true)
  expect(
    todaySchema.safeParse({
      ...emptyToday,
      request_counts: { ...emptyToday.request_counts, new: 1 },
    }).success,
  ).toBe(false)
  expect(
    todaySchema.safeParse({
      ...emptyToday,
      finance: [
        { currency: 'EUR', outstanding_minor: 70000, overdue_minor: '0' },
      ],
    }).success,
  ).toBe(false)
})
it('rejects executable and credential-bearing URLs before rendering record links', () => {
  expect(detailSchema.safeParse(detail).success).toBe(true)
  for (const reference_url of [
    'javascript:alert(1)',
    'https://user:password@example.com',
    'data:text/html,unsafe',
  ])
    expect(detailSchema.safeParse({ ...detail, reference_url }).success).toBe(
      false,
    )
})
it('binds detail to the requested brand and request, including evidence parents', async () => {
  respond({ data: { ...detail, client_id: other } })
  await expect(
    api.detail(client, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  respond({
    data: {
      ...detail,
      evidence: [
        {
          id: other,
          client_id: other,
          request_id: id,
          delivery_id: null,
          filename: 'synthetic.png',
          mime: 'image/png',
          size: 30,
          created_at: at,
        },
      ],
    },
  })
  await expect(
    api.detail(client, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('rejects a review that does not belong to a displayed delivery', () => {
  expect(
    detailSchema.safeParse({
      ...detail,
      reviews: [
        {
          id: other,
          delivery_id: other,
          reviewed_by: other,
          reviewer_name: 'Synthetic reviewer',
          decision: 'approved',
          reason: '',
          created_at: at,
        },
      ],
    }).success,
  ).toBe(false)
})
it('rejects timeline pages outside their request or chronological boundary', async () => {
  const event = {
    id: other,
    request_id: id,
    sequence: '1',
    actor_id: other,
    actor_name: 'Synthetic actor',
    action: 'created',
    status: 'new',
    text: '',
    delivery_id: null,
    created_at: at,
  }
  respond({ data: [event], page: { limit: 25, next_after: null } })
  await expect(
    api.timeline(client, id, '1', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  respond({
    data: [{ ...event, request_id: other }],
    page: { limit: 25, next_after: null },
  })
  await expect(
    api.timeline(client, id, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('rejects upload receipts for a different private object and uses authenticated raw transport', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  respond({ data: { id: other, replayed: false } })
  await expect(
    api.upload(
      client,
      id,
      new File(['synthetic'], 'synthetic.png', { type: 'image/png' }),
    ),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-CSRF-Token': 'a'.repeat(43) },
  })
})
it('rejects older delivery pages with foreign or unordered versions', async () => {
  const delivery = {
    id: other,
    request_id: other,
    number: 2,
    delivered_by: other,
    developer_name: 'Synthetic developer',
    summary: 'Delivered synthetic change.',
    test_notes: '',
    implementation_url: '',
    reference: '',
    created_at: at,
  }
  respond({
    data: [delivery],
    reviews: [],
    page: { limit: 25, next_before: null },
  })
  await expect(
    api.deliveries(client, id, '3', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
