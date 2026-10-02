import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  cursorSchema,
  matchesFilters,
  parseDetail,
  parsePage,
  sameSummary,
  validateFilters,
} from './models'
import type { Filters, Summary } from './models'
function endpoint(scope?: string) {
  if (scope && !isUUID(scope)) throw new APIError(0, 'invalid_request')
  return scope ? `/api/v1/clients/${scope}/audit-logs` : '/api/v1/audit-logs'
}
export async function list(
  scope: string | undefined,
  input: Filters,
  cursor: string,
  signal: AbortSignal,
) {
  const path = endpoint(scope),
    filters = validateFilters(input, scope)
  if (cursor && !cursorSchema.safeParse(cursor).success)
    throw new APIError(0, 'invalid_request')
  const query = new URLSearchParams({ limit: '25' })
  for (const [key, value] of Object.entries(filters))
    if (value) query.set(key, value)
  if (cursor) query.set('cursor', cursor)
  const page = parsePage(
    await authenticatedJSON(`${path}?${query}`, { signal }),
  )
  if (
    page.data.some(
      (row) =>
        (scope && row.client_id !== scope) || !matchesFilters(row, filters),
    ) ||
    (cursor && page.page.next_cursor === cursor)
  )
    throw new APIError(0, 'invalid_response')
  return page
}
export async function inspect(
  scope: string | undefined,
  row: Summary,
  signal: AbortSignal,
) {
  const path = endpoint(scope)
  if (!isUUID(row.id)) throw new APIError(0, 'invalid_request')
  const detail = parseDetail(
    await authenticatedJSON(`${path}/${row.id}`, { signal }),
  )
  if (!sameSummary(detail, row) || (scope && detail.client_id !== scope))
    throw new APIError(0, 'invalid_response')
  return detail
}
