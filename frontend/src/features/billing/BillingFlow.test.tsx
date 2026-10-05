import { expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  collection,
  payment,
  identity,
  clientID,
  recordID,
  paymentID,
  otherID,
  date,
} from './fixtures.test-data'
import { billingPermissions } from './hooks'
import { safeReturnTo } from '../shell/navigation'
import { exponents } from './money'
const base = `/api/v1/clients/${clientID}/billing`,
  route = `/app/clients/${clientID}/billing`,
  detail = route + '/' + recordID
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const page = (data: unknown[]) => ({
  data,
  page: { limit: 25, next_cursor: null },
})
type Override = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response> | undefined
function setup(
  path = route,
  session: Session = identity,
  override: Override = () => undefined,
  initial = collection,
) {
  const record = structuredClone(initial),
    payments: (typeof payment)[] = [],
    cache = createQueryClient()
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const custom = override(url, init)
    if (custom) return Promise.resolve(custom)
    if (url === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (url === '/api/v1/auth/session')
      return Promise.resolve(json({ data: session }))
    if (init.method === 'GET') {
      if (url.endsWith('/pricing-snapshot'))
        return Promise.resolve(
          json(
            { error: { code: 'not_found', message: 'No copied terms.' } },
            404,
          ),
        )
      if (url === base + '/summary')
        return Promise.resolve(
          json({
            data: [
              {
                currency: 'USD',
                currency_exponent: 2,
                amount_minor: '10000',
                paid_minor: '2500',
                outstanding_minor: '7500',
                overdue_minor: '7500',
                cancelled_amount_minor: '0',
                cancelled_paid_minor: '0',
              },
              {
                currency: 'KWD',
                currency_exponent: 3,
                amount_minor: '1001',
                paid_minor: '0',
                outstanding_minor: '1001',
                overdue_minor: '0',
                cancelled_amount_minor: '0',
                cancelled_paid_minor: '0',
              },
            ],
          }),
        )
      if (url === base + '/currencies')
        return Promise.resolve(
          json({
            data: Object.entries(exponents).map(([code, exponent]) => ({
              code,
              exponent,
            })),
          }),
        )
      if (url.startsWith(base + '?'))
        return Promise.resolve(json(page([record])))
      if (url === base + '/' + recordID)
        return Promise.resolve(json({ data: record }))
      if (url.startsWith(base + '/' + recordID + '/payments?'))
        return Promise.resolve(json(page(payments)))
      throw new Error('Unexpected private read: ' + url)
    }
    const body = JSON.parse(init.body as string)
    record.revision = String(BigInt(body.expected_revision ?? '0') + 1n)
    if (url.endsWith('/payments')) {
      record.paid_minor = '2500'
      record.outstanding_minor = '7500'
      record.status = 'partially_paid'
      const { expected_revision, ...input } = body
      void expected_revision
      payments.push({ ...payment, ...input })
      return Promise.resolve(
        json({
          data: {
            id: recordID,
            revision: record.revision,
            payment_id: paymentID,
            replayed: false,
          },
        }),
      )
    }
    if (url.endsWith('/cancel')) {
      record.status = 'cancelled'
      record.cancelled_at = date
      record.outstanding_minor = '0'
    } else {
      const { expected_revision, ...profile } = body
      void expected_revision
      Object.assign(record, profile)
      record.outstanding_minor = String(
        BigInt(record.amount_minor) - BigInt(record.paid_minor),
      )
    }
    return Promise.resolve(
      json({
        data: {
          id: recordID,
          revision: record.revision,
          payment_id: null,
          replayed: false,
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { fetcher, cache, record, payments }
}
const writes = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([, i]) => ['POST', 'PUT'].includes(i.method))
async function pay(amount = '25.00') {
  fireEvent.change(await screen.findByLabelText('Payment amount (USD)'), {
    target: { value: amount },
  })
  fireEvent.change(screen.getByLabelText('Payment date (UTC calendar)'), {
    target: { value: '2026-10-01' },
  })
  fireEvent.change(screen.getByLabelText('Payment reference'), {
    target: { value: payment.reference },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Record payment' }))
}
it('shows server totals separately and opens billing-only routes without unrelated reads', async () => {
  const view = {
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        {
          permission: 'billing.view',
          scope: 'client' as const,
          client_id: clientID,
        },
      ],
    },
  }
  const { fetcher } = setup(route, view)
  const table = await screen.findByRole('table', {
    name: 'Balances by currency',
  })
  expect(table).toHaveTextContent('USD 75.00')
  expect(table).toHaveTextContent('KWD 1.001')
  expect(
    screen.queryByRole('link', { name: 'Create collection' }),
  ).not.toBeInTheDocument()
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === '/api/v1/auth/session' ||
        url === '/api/v1/auth/preferences' ||
        url.startsWith(base),
    ),
  ).toBe(true)
  expect(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText(
      'Finance',
    ),
  ).toBeVisible()
})
it('requires independent client-scoped grants, never billing.manage or role names', () => {
  for (let mask = 0; mask < 16; mask++) {
    const keys = [
        'billing.view',
        'billing.create',
        'billing.update',
        'billing.delete',
      ],
      grants = keys
        .filter((_, i) => mask & (1 << i))
        .map((permission) => ({
          permission,
          scope: 'client' as const,
          client_id: clientID,
        })),
      p = billingPermissions(grants, clientID)
    expect([p.view, p.create, p.update, p.cancel]).toEqual([
      !!(mask & 1),
      !!(mask & 1) && !!(mask & 2),
      !!(mask & 1) && !!(mask & 4),
      !!(mask & 1) && !!(mask & 8),
    ])
    expect(billingPermissions(grants, otherID).view).toBe(false)
  }
  expect(
    billingPermissions(
      [{ permission: 'billing.manage', scope: 'global' }],
      clientID,
    ).update,
  ).toBe(false)
})
it('denies the wrong client without a private request and validates safe return routes', async () => {
  const { fetcher } = setup(route.replace(clientID, otherID))
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        url === '/api/v1/auth/session' || url === '/api/v1/auth/preferences',
    ),
  ).toBe(true)
  expect(safeReturnTo(detail + '/edit')).toBe(detail + '/edit')
  expect(safeReturnTo(route + '/new/edit')).toBe('/app')
  expect(safeReturnTo(route + '?secret=x')).toBe('/app')
})
it('creates exact collection amounts and edits metadata while preserving fixed paid amounts', async () => {
  const { fetcher } = setup(route + '/new')
  await screen.findByLabelText('Collection description')
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create collection' }),
    ).toBeEnabled(),
  )
  fireEvent.change(screen.getByLabelText('Collection description'), {
    target: { value: 'Synthetic exact collection' },
  })
  fireEvent.change(screen.getByLabelText('Currency'), {
    target: { value: 'USD' },
  })
  fireEvent.change(screen.getByLabelText('Collection amount'), {
    target: { value: '90071992547409.93' },
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Create collection' }),
  )
  await screen.findByRole('heading', { name: 'Collection details' })
  expect(JSON.parse(writes(fetcher)[0]![1].body)).toMatchObject({
    amount_minor: '9007199254740993',
    currency: 'USD',
    due_date: null,
  })
  await userEvent.click(
    await screen.findByRole('link', { name: 'Edit collection' }),
  )
  await screen.findByRole('heading', { name: 'Edit collection' })
  fireEvent.change(screen.getByLabelText('Internal note'), {
    target: { value: 'Updated synthetic note' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Save collection' }))
  await screen.findByRole('heading', { name: 'Collection details' })
  expect(JSON.parse(writes(fetcher)[1]![1].body)).toMatchObject({
    amount_minor: '9007199254740993',
    currency: 'USD',
    expected_revision: '1',
    internal_note: 'Updated synthetic note',
  })
})
it('records a partial payment, masks references and deliberately cancels with retained history', async () => {
  const { fetcher } = setup(detail)
  await screen.findByLabelText('Payment reference')
  fireEvent.change(screen.getByLabelText('Payment reference'), {
    target: { value: payment.reference },
  })
  await pay()
  await screen.findByRole('dialog', { name: 'Payment confirmed' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Return to collection' }),
  )
  await screen.findByText('Partially paid')
  expect(screen.queryByText(payment.reference)).not.toBeInTheDocument()
  const reveal = screen.getByRole('button', {
    name: /Reveal reference for payment/,
  })
  await userEvent.click(reveal)
  expect(screen.getByText(payment.reference)).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: /Hide reference for payment/ }),
  )
  expect(screen.queryByText(payment.reference)).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Cancel collection' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Cancel collection?' })
  expect(dialog).toHaveTextContent('not refunded')
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Keep collection' }),
  )
  expect(writes(fetcher)).toHaveLength(1)
  await userEvent.click(
    screen.getByRole('button', { name: 'Cancel collection' }),
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Confirm cancellation' }),
  )
  await screen.findByText('Collection cancelled. Payment history retained.')
  expect(
    screen.getByRole('table', { name: 'Collection payments' }),
  ).toHaveTextContent('USD 25.00')
  expect(
    screen.queryByRole('button', { name: 'Record payment' }),
  ).not.toBeInTheDocument()
  expect(JSON.parse(writes(fetcher)[1]![1].body)).toEqual({
    expected_revision: '9007199254740994',
    confirm: true,
  })
})
it('rejects overprecision and overpayment without issuing a command', async () => {
  const { fetcher } = setup(detail)
  await pay('1.001')
  expect(await screen.findByText(/Use at most 2 decimal places/)).toBeVisible()
  await pay('101')
  expect(
    await screen.findByText(/exceeds the current outstanding/),
  ).toBeVisible()
  expect(writes(fetcher)).toHaveLength(0)
})
it('preserves the identical original command after uncertain commit and warns before unloading', async () => {
  let count = 0
  const { fetcher } = setup(detail, identity, (url, init) => {
    if (url.endsWith('/payments') && init.method === 'POST') {
      count++
      return count === 1
        ? Promise.reject(new TypeError('synthetic connection lost'))
        : json({
            data: {
              id: recordID,
              revision: '9007199254740995',
              payment_id: paymentID,
              replayed: true,
            },
          })
    }
  })
  await pay()
  const dialog = await screen.findByRole('dialog', {
    name: 'Confirming payment',
  })
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Retry original payment' }),
    ).toBeEnabled(),
  )
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(dialog).toBeInTheDocument()
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await userEvent.click(
    screen.getByRole('button', { name: 'Retry original payment' }),
  )
  await screen.findByRole('dialog', { name: 'Payment confirmed' })
  const calls = writes(fetcher)
  expect(calls).toHaveLength(2)
  expect(calls[1]![1].body).toBe(calls[0]![1].body)
  expect(JSON.parse(calls[1]![1].body).expected_revision).toBe(
    '9007199254740993',
  )
  expect(screen.getByRole('dialog')).toHaveTextContent('No second payment')
})
it('reconciles an unknown commit from immutable history without a second write', async () => {
  const { fetcher } = setup(detail, identity, (url, init) => {
    if (url.endsWith('/payments') && init.method === 'POST')
      return Promise.reject(new Error('unknown outcome'))
    if (url.includes('/payments?') && writes(fetcher).length) {
      const command = JSON.parse(writes(fetcher)[0]![1].body)
      const { expected_revision, ...input } = command
      void expected_revision
      return json(page([{ ...payment, ...input }]))
    }
  })
  await pay()
  await screen.findByRole('button', { name: 'Check recorded payments' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Check recorded payments' }),
  )
  await screen.findByRole('dialog', { name: 'Payment confirmed' })
  expect(writes(fetcher)).toHaveLength(1)
  expect(screen.getByRole('dialog')).toHaveTextContent('confirmed in history')
})
it('reports definite stale conflicts and forces current-data review', async () => {
  const { fetcher } = setup(detail, identity, (url, init) =>
    url.endsWith('/payments') && init.method === 'POST'
      ? json({ error: { code: 'conflict' } }, 409)
      : undefined,
  )
  await pay()
  await screen.findByRole('dialog', { name: 'Payment not recorded' })
  expect(screen.getByRole('dialog')).toHaveTextContent('Reload current data')
  expect(
    screen.queryByRole('button', { name: 'Retry original payment' }),
  ).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Reload collection before retrying' }),
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  )
  expect(writes(fetcher)).toHaveLength(1)
})
it('keeps an uncertain command frozen after a conflicting retry and unmatched history', async () => {
  let count = 0
  const { fetcher } = setup(detail, identity, (url, init) => {
    if (url.endsWith('/payments') && init.method === 'POST')
      return ++count === 1
        ? Promise.reject(new Error('lost response'))
        : json({ error: { code: 'conflict' } }, 409)
  })
  await pay()
  await userEvent.click(
    await screen.findByRole('button', { name: 'Retry original payment' }),
  )
  await screen.findByRole('button', { name: 'Retry original payment' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Check recorded payments' }),
  )
  await screen.findByText(/outcome remains unconfirmed/)
  expect(
    screen.queryByRole('button', { name: 'Reload collection before retrying' }),
  ).not.toBeInTheDocument()
  expect(writes(fetcher)).toHaveLength(2)
  expect(writes(fetcher)[0]![1].body).toBe(writes(fetcher)[1]![1].body)
})
it('drops an unresolved private command on access loss and suppresses a late success', async () => {
  let resolve: (response: Response) => void = () => undefined
  const { cache } = setup(detail, identity, (url, init) =>
    url.endsWith('/payments') && init.method === 'POST'
      ? new Promise<Response>((r) => {
          resolve = r
        })
      : undefined,
  )
  await pay()
  await screen.findByRole('dialog', { name: 'Confirming payment' })
  await act(async () => {
    cache.setQueryData(sessionKey, {
      session: { ...identity, user: { ...identity.user, permissions: [] } },
      expired: false,
    })
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => {
    resolve(
      json({
        data: {
          id: recordID,
          revision: '9007199254740994',
          payment_id: paymentID,
          replayed: false,
        },
      }),
    )
  })
  expect(
    screen.queryByRole('dialog', { name: 'Payment confirmed' }),
  ).not.toBeInTheDocument()
})
it('shows loading failures and empty state safely', async () => {
  setup(route, identity, (url) =>
    url.startsWith(base + '?')
      ? json(page([]))
      : url === base + '/summary'
        ? json({ error: { code: 'internal_error' } }, 500)
        : undefined,
  )
  await screen.findByText('No collections on this page')
  expect(screen.getByRole('alert')).not.toHaveTextContent('internal_error')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
})
it('clears private history, references and recovery on grant revocation', async () => {
  const { cache } = setup(detail)
  await pay()
  await screen.findByRole('dialog', { name: 'Payment confirmed' })
  await userEvent.click(
    screen.getByRole('button', { name: 'Return to collection' }),
  )
  await userEvent.click(
    await screen.findByRole('button', { name: /Reveal reference for payment/ }),
  )
  expect(screen.getByText(payment.reference)).toBeVisible()
  await act(async () => {
    cache.setQueryData(sessionKey, {
      session: { ...identity, user: { ...identity.user, permissions: [] } },
      expired: false,
    })
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText(payment.reference)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('table', { name: 'Collection payments' }),
  ).not.toBeInTheDocument()
})
