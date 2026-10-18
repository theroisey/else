import { afterEach, expect, it, vi } from 'vitest'
import {
  dashboardSchema,
  expenseSchema,
  expenses,
  mutateExpense,
  expense,
  events,
  dashboard,
  query,
  type Filters,
} from './service'
const position = Object.fromEntries(
  [
    'amount_minor',
    'paid_minor',
    'outstanding_minor',
    'overdue_minor',
    'cancelled_amount_minor',
    'cancelled_paid_minor',
    'issued_minor',
    'count',
    'paid_count',
    'partial_count',
    'unpaid_count',
    'overdue_count',
    'cancelled_count',
    'debtor_count',
    'fully_paid_minor',
    'partial_outstanding_minor',
    'unpaid_minor',
  ].map((k) => [k, '0']),
)
const activity = {
  gross_minor: '0',
  reversed_minor: '0',
  net_minor: '0',
  roise_minor: '0',
  partner_minor: '0',
  unknown_minor: '0',
  payment_count: '0',
  reversal_count: '0',
  latest_date: null,
}
const empty = () => ({
  as_of: '2026-10-18T12:00:00.000000Z',
  client_id: null,
  currency: 'EUR',
  from: '2026-10-01',
  to: '2026-10-18',
  previous_from: '2026-09-13',
  previous_to: '2026-09-30',
  group: 'month',
  position: { ...position },
  alerts: [],
  activity: { ...activity },
  previous: { ...activity },
  prior_year: { ...activity },
  year_from: '2025-10-01',
  year_to: '2025-10-18',
  aging: [],
  upcoming: [],
  trends: [],
  methods: [],
  collectors: [],
  services: [],
  attention: [],
  concentration: [],
  partners: [],
  expenses: null,
  settlements: { incoming_minor: '0', outgoing_minor: '0' },
  positive_client_net_minor: '0',
  agreements: [],
  cashflow: null,
})
afterEach(() => vi.unstubAllGlobals())
it('validates exact snapshot reconciliation and distinguishes restricted expense coverage', () => {
  expect(dashboardSchema.parse(empty()).expenses).toBeNull()
  const invalid = empty()
  invalid.position.amount_minor = '100'
  expect(dashboardSchema.safeParse(invalid).success).toBe(false)
  const forged = empty()
  forged.activity.net_minor = '100'
  expect(dashboardSchema.safeParse(forged).success).toBe(false)
  expect(
    dashboardSchema.safeParse({ ...empty(), private_costs: '100' }).success,
  ).toBe(false)
  expect(
    expenseSchema.safeParse({ amount_minor: '100', paid_minor: '101' }).success,
  ).toBe(false)
})
it('rejects a report belonging to a different currency or selected period', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: empty() }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  const filters = {
    currency: 'USD',
    from: '2026-10-01',
    to: '2026-10-18',
    group: 'month',
  } as Filters
  await expect(dashboard(filters)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  expect(
    query({
      currency: 'KWD',
      client_id: '11111111-1111-4111-8111-111111111111',
      status: 'all',
    }),
  ).toBe('currency=KWD&client_id=11111111-1111-4111-8111-111111111111')
})

it('rejects expense responses from another currency, parent, or page', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const other = '22222222-2222-4222-8222-222222222222'
  const row = {
    id,
    client_id: null,
    client_name: null,
    category_id: id,
    category_name: 'Synthetic category',
    title: 'Synthetic cost',
    vendor: '',
    description: '',
    currency: 'EUR',
    amount_minor: '100',
    paid_minor: '0',
    outstanding_minor: '100',
    expense_date: '2026-10-18',
    due_date: null,
    cancelled_at: null,
    revision: '1',
    created_at: '2026-10-18T12:00:00.000000Z',
  }
  const mock = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  mock({ data: { expense: row, event_id: null, replayed: false } })
  await expect(
    mutateExpense('/' + other + '/events', {}),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  await expect(
    mutateExpense('', {
      currency: 'USD',
      client_id: null,
      amount_minor: '100',
    }),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  mock({ data: row })
  await expect(expense(other)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  mock({ data: [row], page: { next_cursor: null } })
  await expect(expenses('USD')).rejects.toMatchObject({
    code: 'invalid_response',
  })
  await expect(expenses('EUR', id)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  mock({
    data: [
      {
        id,
        expense_id: other,
        payment_id: null,
        kind: 'payment',
        amount_minor: '100',
        occurred_on: '2026-10-18',
        method: 'cash',
        reason: '',
        recorded_at: row.created_at,
        expected_revision: '1',
      },
    ],
    page: { next_cursor: null },
  })
  await expect(events(id)).rejects.toMatchObject({ code: 'invalid_response' })
})
