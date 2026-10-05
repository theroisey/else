import { websiteAPIBase } from '../websites/service'
import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import {
  connectionSchema,
  parseConnection,
  revisionSchema,
} from '../integrations/models'
import type { Connection } from '../integrations/models'
import {
  parseCatalog,
  parseQueued,
  parseView,
  validPeriod,
  validToken,
} from './models'
import type { Period } from './models'

function path(client: string, connection?: string) {
  if (!isUUID(client) || (connection !== undefined && !isUUID(connection)))
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/marketing${connection ? '/' + connection : ''}`
}
export async function list(client: string, after: string, signal: AbortSignal) {
  if (after && !isUUID(after)) throw new APIError(0, 'invalid_request')
  return parseCatalog(
    await authenticatedJSON(path(client) + (after ? '?after=' + after : ''), {
      signal,
    }),
    client,
    after,
  )
}
export async function read(
  client: string,
  connection: string,
  period: Period,
  signal: AbortSignal,
  website?: string,
) {
  if (!validPeriod(period)) throw new APIError(0, 'invalid_request')
  return parseView(
    await authenticatedJSON(
      websiteAPIBase(client, website) +
        '/marketing/' +
        connection +
        '?' +
        new URLSearchParams({ ...period }),
      { signal },
    ),
    client,
    connection,
    period,
  )
}
export async function create(client: string, account: string) {
  path(client)
  if (!/^[1-9][0-9]{0,19}$/.test(account))
    throw new APIError(0, 'invalid_request')
  const body = await authenticatedJSON(
    `/api/v1/clients/${client}/integrations/meta_ads`,
    { method: 'POST', body: { account_id: account } },
  )
  const id = connectionSchema.safeParse(
    (body as { data?: unknown } | null)?.data,
  )
  if (!id.success) throw new APIError(0, 'invalid_response')
  const record = parseConnection(body, client, id.data.id)
  if (
    record.provider !== 'meta_ads' ||
    record.state !== 'pending' ||
    record.revision !== '1'
  )
    throw new APIError(0, 'invalid_response')
  return record
}
export async function queue(
  record: Connection,
  period: Period,
  credential?: string,
  website?: string,
) {
  path(record.client_id, record.id)
  if (
    !validPeriod(period) ||
    record.provider !== 'meta_ads' ||
    !['pending', 'connected', 'reauthorization_required'].includes(
      record.state,
    ) ||
    !revisionSchema.safeParse(record.revision).success ||
    BigInt(record.revision) > 9223372036854775805n ||
    (credential !== undefined && !validToken(credential))
  )
    throw new APIError(0, 'invalid_request')
  return parseQueued(
    await authenticatedJSON(
      `${websiteAPIBase(record.client_id, website)}/integrations/${record.id}/meta_ads/${credential === undefined ? 'sync' : 'credentials'}`,
      {
        method: 'POST',
        body: {
          revision: record.revision,
          ...period,
          ...(credential === undefined ? {} : { access_token: credential }),
        },
      },
    ),
    BigInt(record.revision) + (credential === undefined ? 0n : 2n),
  )
}
