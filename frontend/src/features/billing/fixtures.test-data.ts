import type { Collection, Payment } from './models'
import type { Session } from '../auth/session'
export const clientID = '22222222-2222-4222-8222-222222222222',
  actorID = '11111111-1111-4111-8111-111111111111',
  recordID = '33333333-3333-4333-8333-333333333333',
  paymentID = '44444444-4444-4444-8444-444444444444',
  otherID = '55555555-5555-4555-8555-555555555555'
export const date = '2026-10-02T00:00:00Z'
export const collection: Collection = {
  id: recordID,
  client_id: clientID,
  created_by: actorID,
  description: 'Synthetic finance collection',
  internal_note: 'Synthetic private collection note',
  amount_minor: '10000',
  currency: 'USD',
  currency_exponent: 2,
  due_date: '2026-12-01',
  paid_minor: '0',
  outstanding_minor: '10000',
  status: 'pending',
  revision: '9007199254740993',
  cancelled_at: null,
  created_at: date,
  updated_at: date,
}
export const payment: Payment = {
  id: paymentID,
  command_id: otherID,
  client_id: clientID,
  collection_id: recordID,
  recorded_by: actorID,
  amount_minor: '2500',
  currency: 'USD',
  paid_on: '2026-10-01',
  method: 'bank_transfer',
  reference: 'Synthetic private payment reference',
  note: 'Synthetic private payment note',
  collection_revision: '9007199254740994',
  recorded_at: date,
}
export const identity: Session = {
  user: {
    id: actorID,
    email: 'finance.fixture@example.com',
    display_name: 'Finance Fixture',
    permissions: [
      'billing.view',
      'billing.create',
      'billing.update',
      'billing.delete',
    ].map((permission) => ({
      permission,
      scope: 'client',
      client_id: clientID,
    })),
  },
  session: { expires_at: new Date(Date.now() + 3600000).toISOString() },
}
