import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  parsePage,
  parseCollection,
  parsePayments,
  parseSummary,
  parseCurrencies,
  parseMutation,
  profileSchema,
  paymentSchema,
  revisionSchema,
  states,
  currencies,
} from './models'
import type { Profile, PaymentInput, Filter } from './models'
import { maxInt64 } from './money'
function path(client: string, id?: string) {
  if (!isUUID(client) || (id !== undefined && !isUUID(id)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/billing${id ? '/' + id : ''}`
}
function paging(cursor: string) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return q
}
function bound(
  client: string,
  id: string | undefined,
  records: { client_id: string; id: string }[],
) {
  if (
    records.some(
      (r) =>
        r.client_id !== client.toLowerCase() ||
        (id && r.id !== id.toLowerCase()),
    )
  )
    throw new APIError(0, 'invalid_response')
}
export async function list(
  client: string,
  f: Filter,
  cursor: string,
  signal?: AbortSignal,
) {
  if (
    ![...states, 'all'].includes(f.status) ||
    (f.currency && !currencies.includes(f.currency)) ||
    [...f.search.trim()].length > 100 ||
    /[\p{Cc}]/u.test(f.search)
  )
    throw new APIError(0, 'invalid_request')
  const q = paging(cursor)
  q.set('status', f.status)
  if (f.currency) q.set('currency', f.currency)
  if (f.search.trim()) q.set('search', f.search.trim())
  const p = parsePage(
    await authenticatedJSON(`${path(client)}?${q}`, signal ? { signal } : {}),
  )
  bound(client, undefined, p.data)
  if (
    p.data.some(
      (r) =>
        (f.currency && r.currency !== f.currency) ||
        (f.status !== 'all' && r.status !== f.status) ||
        (cursor && r.id <= cursor.toLowerCase()),
    )
  )
    throw new APIError(0, 'invalid_response')
  return p
}
export async function detail(client: string, id: string, signal?: AbortSignal) {
  const r = parseCollection(
    await authenticatedJSON(path(client, id), signal ? { signal } : {}),
  )
  bound(client, id, [r])
  return r
}
export async function payments(
  client: string,
  id: string,
  cursor: string,
  signal?: AbortSignal,
) {
  const p = parsePayments(
    await authenticatedJSON(
      `${path(client, id)}/payments?${paging(cursor)}`,
      signal ? { signal } : {},
    ),
  )
  bound(client, undefined, p.data)
  if (
    p.data.some(
      (r) =>
        r.collection_id !== id.toLowerCase() ||
        (cursor && r.id <= cursor.toLowerCase()),
    )
  )
    throw new APIError(0, 'invalid_response')
  return p
}
export async function summary(client: string, signal?: AbortSignal) {
  return parseSummary(
    await authenticatedJSON(
      path(client) + '/summary',
      signal ? { signal } : {},
    ),
  )
}
export async function currencyCatalog(client: string, signal?: AbortSignal) {
  return parseCurrencies(
    await authenticatedJSON(
      path(client) + '/currencies',
      signal ? { signal } : {},
    ),
  )
}
function expected(revision: string) {
  if (
    !revisionSchema.safeParse(revision).success ||
    BigInt(revision) >= maxInt64
  )
    throw new APIError(0, 'invalid_request')
}
function confirmed(
  body: unknown,
  revision: string,
  id?: string,
  payment = false,
) {
  const r = parseMutation(body),
    next = BigInt(revision)
  if (
    (id && r.id !== id.toLowerCase()) ||
    (payment
      ? !r.payment_id ||
        (r.replayed ? BigInt(r.revision) < next : BigInt(r.revision) !== next)
      : r.payment_id !== null || r.replayed || BigInt(r.revision) !== next)
  )
    throw new APIError(0, 'invalid_response')
  return r
}
export async function create(client: string, profile: Profile) {
  return confirmed(
    await authenticatedJSON(path(client), {
      method: 'POST',
      body: profileSchema.parse(profile),
    }),
    '1',
  )
}
export async function update(
  client: string,
  id: string,
  profile: Profile,
  revision: string,
) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(client, id), {
      method: 'PUT',
      body: { ...profileSchema.parse(profile), expected_revision: revision },
    }),
    String(BigInt(revision) + 1n),
    id,
  )
}
export async function cancel(client: string, id: string, revision: string) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(client, id) + '/cancel', {
      method: 'POST',
      body: { expected_revision: revision, confirm: true },
    }),
    String(BigInt(revision) + 1n),
    id,
  )
}
export async function recordPayment(
  client: string,
  id: string,
  payment: PaymentInput,
  revision: string,
) {
  expected(revision)
  return confirmed(
    await authenticatedJSON(path(client, id) + '/payments', {
      method: 'POST',
      body: { ...paymentSchema.parse(payment), expected_revision: revision },
    }),
    String(BigInt(revision) + 1n),
    id,
    true,
  )
}
