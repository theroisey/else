import { expect, it, vi } from 'vitest'
import * as api from './service'
import { defaultFilter } from './models'
import {
  clientID,
  recordID,
  paymentID,
  otherID,
  collection,
  payment,
} from './fixtures.test-data'
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
function mock(body: unknown) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn().mockResolvedValue(json(body))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
it('sends exact canonical payload and revision with guarded CSRF', async () => {
  const fetcher = mock({
    data: {
      id: recordID,
      revision: '9007199254740994',
      payment_id: paymentID,
      replayed: false,
    },
  })
  const {
    id,
    client_id,
    collection_id,
    recorded_by,
    recorded_at,
    collection_revision,
    ...input
  } = payment
  void id
  void client_id
  void collection_id
  void recorded_by
  void recorded_at
  void collection_revision
  await api.recordPayment(clientID, recordID, input, collection.revision)
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    ...input,
    expected_revision: collection.revision,
  })
  expect(fetcher.mock.calls[0]![1].headers['X-CSRF-Token']).toBe('a'.repeat(43))
})
it('accepts committed replay at a later exact revision, rejecting mismatched IDs', async () => {
  mock({
    data: {
      id: recordID,
      revision: '9223372036854775807',
      payment_id: paymentID,
      replayed: true,
    },
  })
  const input = {
    command_id: payment.command_id,
    amount_minor: '2500',
    currency: 'USD' as const,
    paid_on: payment.paid_on,
    method: payment.method,
    reference: payment.reference,
    note: payment.note,
  }
  expect(
    (await api.recordPayment(clientID, recordID, input, collection.revision))
      .replayed,
  ).toBe(true)
  mock({
    data: {
      id: otherID,
      revision: '9007199254740994',
      payment_id: paymentID,
      replayed: false,
    },
  })
  await expect(
    api.recordPayment(clientID, recordID, input, collection.revision),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('rejects wrong-client and invalid cursor responses', async () => {
  mock({ data: { ...collection, client_id: otherID } })
  await expect(api.detail(clientID, recordID)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  const fetcher = mock({ data: [], page: { limit: 25, next_cursor: null } })
  await expect(api.list(clientID, defaultFilter, '../')).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(fetcher).not.toHaveBeenCalled()
})
it('encodes bounded literal filters and rejects invalid writes before transport', async () => {
  const fetcher = mock({ data: [], page: { limit: 25, next_cursor: null } })
  await api.list(
    clientID,
    { search: 'Synthetic & literal', status: 'overdue', currency: 'KWD' },
    '',
  )
  expect(fetcher.mock.calls[0]![0]).toContain('search=Synthetic+%26+literal')
  await expect(
    api.cancel(clientID, recordID, '9223372036854775807'),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(api.detail('../', recordID)).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
