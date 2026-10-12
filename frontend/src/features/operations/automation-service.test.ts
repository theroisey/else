import { authenticatedJSON } from '../../services/authenticated'
import { afterEach, expect, it, vi } from 'vitest'
import { terms, period, readPeriod } from './commercial-service'
import { list } from './recurring-service'
import { localDate } from './preferences-service'
const client = '11111111-1111-4111-8111-111111111111',
  id = '22222222-2222-4222-8222-222222222222',
  other = '33333333-3333-4333-8333-333333333333',
  at = '2026-10-11T12:00:00.000000Z'
const position = {
  id,
  client_id: client,
  agreement_id: other,
  version_id: other,
  collection_id: other,
  currency: 'EUR',
  period_key: '2026-10',
  billing_date: '2026-10-11',
  voided_at: null,
  voided_by: null,
  void_reason: '',
  title: 'Synthetic consulting',
  partner_id: other,
  partner_name: 'Synthetic partner',
  collector: 'partner',
  allocation_policy: 'proportional',
  collection_revision: '1',
  due_date: '2026-10-11',
  settlement_revision: '1',
  amount_minor: '70000',
  paid_minor: '35000',
  roise_share_minor: '20000',
  outstanding_minor: '35000',
  partner_share_minor: '50000',
  roise_recognized_minor: '10000',
  partner_recognized_minor: '25000',
  internal_due_to_roise_minor: '10000',
  settled_to_roise_minor: '0',
  internal_remaining_to_roise_minor: '10000',
}
const template = {
  id,
  client_id: client,
  created_by: other,
  managed_by: other,
  manager_name: 'Synthetic manager',
  automation_failure: null,
  status: 'active',
  next_date: '2026-10-12',
  revision: '2',
  generated_count: '1',
  current_version: '1',
  created_at: at,
  updated_at: at,
  title: 'Synthetic recurring task',
  description: '',
  priority: 'medium',
  website_id: null,
  website_name: null,
  assignee_id: other,
  assignee_name: 'Synthetic employee',
  supervisor_id: null,
  supervisor_name: null,
  start_date: '2026-10-11',
  end_date: null,
  frequency: 'daily',
  interval: 1,
  anchor_day: 11,
  due_time: '09:00',
  timezone: 'Europe/Bucharest',
  occurrence_limit: null,
}
function respond(value: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('validates an included 200/500 split and rejects an extra customer charge or floating money', () => {
  expect(
    terms.safeParse({
      amount_minor: '70000',
      currency: 'EUR',
      roise_share_minor: '20000',
      partner_id: other,
      collector: 'partner',
      allocation_policy: 'proportional',
    }).success,
  ).toBe(true)
  expect(
    terms.safeParse({
      amount_minor: '70000',
      currency: 'EUR',
      roise_share_minor: '90000',
      partner_id: other,
      collector: 'partner',
      allocation_policy: 'proportional',
    }).success,
  ).toBe(false)
  expect(period.safeParse(position).success).toBe(true)
  for (const patch of [
    { paid_minor: 35000 },
    { outstanding_minor: '55000' },
    { partner_share_minor: '70000' },
    { internal_remaining_to_roise_minor: '20000' },
  ])
    expect(period.safeParse({ ...position, ...patch }).success).toBe(false)
  expect(
    period.safeParse({
      ...position,
      voided_at: at,
      voided_by: other,
      void_reason: 'Synthetic correction',
      paid_minor: '0',
      outstanding_minor: '0',
      roise_recognized_minor: '0',
      partner_recognized_minor: '0',
      internal_due_to_roise_minor: '0',
      internal_remaining_to_roise_minor: '0',
    }).success,
  ).toBe(true)
})
it('binds commercial periods and recurrence pages to their requested brand', async () => {
  respond({ data: { ...position, client_id: other } })
  await expect(
    readPeriod(client, id, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  respond({
    data: [{ ...template, client_id: other }],
    page: { limit: 25, next_cursor: null },
  })
  await expect(
    list(client, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('rejects recurring pages preceding the cursor or with out-of-order rows', async () => {
  respond({ data: [template], page: { limit: 25, next_cursor: null } })
  await expect(
    list(client, other, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  respond({
    data: [{ ...template, id: other }, template],
    page: { limit: 25, next_cursor: null },
  })
  await expect(
    list(client, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('derives local calendar dates across timezone midnight, month-end and daylight-saving changes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-28T22:30:00Z'))
  expect(localDate('Europe/Bucharest')).toBe('2026-03-29')
  expect(localDate('Europe/Bucharest', true)).toBe('2026-03-30')
  vi.setSystemTime(new Date('2026-01-31T22:30:00Z'))
  expect(localDate('Europe/Bucharest')).toBe('2026-02-01')
  expect(localDate('America/New_York', true)).toBe('2026-02-01')
})

it('permits only the registered operational roots through authenticated same-origin transport', async () => {
  for (const path of [
    '/api/v1/tasks?limit=25&status=active',
    '/api/v1/operations-people?limit=25',
    '/api/v1/preferences',
    '/api/v1/operations-settings',
  ]) {
    respond({ data: [] })
    await expect(authenticatedJSON(path)).resolves.toEqual({ data: [] })
    expect(fetch).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      }),
    )
  }
  await expect(
    authenticatedJSON('/api/v1/unregistered?limit=25'),
  ).rejects.toMatchObject({ code: 'invalid_request' })
})
