import { APIError, authenticatedJSON } from '../../services/authenticated'
import { isUUID } from '../auth/session'
import { revisionSchema } from '../billing/models'
import { maxInt64 } from '../billing/money'
import { detail as billingDetail } from '../billing/service'
import {
  parseSheet,
  parseSheets,
  parseVersion,
  parseVersions,
  parseCalculation,
  parseSnapshot,
  parseMutation,
  parseCopy,
  profileSchema,
  copySchema,
} from './models'
import type { Profile, CopyInput } from './models'
function path(client: string, sheet?: string, version?: string) {
  if (
    ![client, ...(sheet ? [sheet] : []), ...(version ? [version] : [])].every(
      isUUID,
    ) ||
    sheet === '' ||
    version === ''
  )
    throw new APIError(0, 'invalid_request')
  return `/api/v1/clients/${client}/pricing${sheet ? '/' + sheet : ''}${version ? '/versions/' + version : ''}`
}
function paging(cursor: string) {
  if (cursor && !isUUID(cursor)) throw new APIError(0, 'invalid_request')
  const q = new URLSearchParams({ limit: '25' })
  if (cursor) q.set('cursor', cursor)
  return q
}
function requireValue(ok: boolean) {
  if (!ok) throw new APIError(0, 'invalid_response')
}
function expected(revision: string, append = false) {
  if (
    !revisionSchema.safeParse(revision).success ||
    (append && BigInt(revision) === maxInt64)
  )
    throw new APIError(0, 'invalid_request')
}
export async function list(
  client: string,
  manage: boolean,
  cursor: string,
  signal?: AbortSignal,
) {
  const p = parseSheets(
    await authenticatedJSON(
      `${path(client)}?${paging(cursor)}`,
      signal ? { signal } : {},
    ),
    manage,
  )
  requireValue(
    p.data.every(
      (v) =>
        v.client_id === client.toLowerCase() &&
        (!cursor || v.id > cursor.toLowerCase()),
    ),
  )
  return p
}
export async function detail(
  client: string,
  sheet: string,
  manage: boolean,
  signal?: AbortSignal,
) {
  const s = parseSheet(
    await authenticatedJSON(path(client, sheet), signal ? { signal } : {}),
    manage,
  )
  requireValue(
    s.client_id === client.toLowerCase() && s.id === sheet.toLowerCase(),
  )
  return s
}
export async function versions(
  client: string,
  sheet: string,
  manage: boolean,
  cursor: string,
  signal?: AbortSignal,
) {
  const p = parseVersions(
    await authenticatedJSON(
      `${path(client, sheet)}/versions?${paging(cursor)}`,
      signal ? { signal } : {},
    ),
    manage,
  )
  requireValue(
    p.data.every(
      (v) =>
        v.client_id === client.toLowerCase() &&
        v.sheet_id === sheet.toLowerCase() &&
        (!cursor || v.id > cursor.toLowerCase()),
    ),
  )
  return p
}
export async function version(
  client: string,
  sheet: string,
  id: string,
  manage: boolean,
  signal?: AbortSignal,
) {
  const v = parseVersion(
    await authenticatedJSON(path(client, sheet, id), signal ? { signal } : {}),
    manage,
  )
  requireValue(
    v.client_id === client.toLowerCase() &&
      v.sheet_id === sheet.toLowerCase() &&
      v.id === id.toLowerCase(),
  )
  return v
}
export async function preview(client: string, p: Profile) {
  const input = profileSchema.parse(p),
    r = parseCalculation(
      await authenticatedJSON(path(client) + '/preview', {
        method: 'POST',
        body: input,
      }),
    )
  requireValue(
    r.currency === input.currency &&
      r.lines.length === input.lines.length &&
      r.lines.every(
        (l, i) =>
          Object.entries(input.lines[i]!).every(
            ([k, v]) => l[k as keyof typeof l] === v,
          ) && l.unit_cost_minor === input.lines[i]!.unit_cost_minor,
      ),
  )
  return r
}
export async function create(client: string, p: Profile) {
  const r = parseMutation(
    await authenticatedJSON(path(client), {
      method: 'POST',
      body: profileSchema.parse(p),
    }),
  )
  requireValue(r.revision === '1')
  return r
}
export async function append(
  client: string,
  sheet: string,
  revision: string,
  p: Profile,
) {
  expected(revision, true)
  const r = parseMutation(
    await authenticatedJSON(path(client, sheet) + '/versions', {
      method: 'POST',
      body: { ...profileSchema.parse(p), expected_revision: revision },
    }),
  )
  requireValue(
    r.id === sheet.toLowerCase() &&
      BigInt(r.revision) === BigInt(revision) + 1n,
  )
  return r
}
export async function copy(
  client: string,
  sheet: string,
  version: string,
  revision: string,
  p: CopyInput,
) {
  expected(revision)
  const r = parseCopy(
    await authenticatedJSON(path(client, sheet, version) + '/collections', {
      method: 'POST',
      body: { ...copySchema.parse(p), expected_revision: revision },
    }),
  )
  requireValue(r.replayed || r.revision === '1')
  return r
}
export async function snapshot(
  client: string,
  id: string,
  signal?: AbortSignal,
) {
  if (!isUUID(client) || !isUUID(id)) throw new APIError(0, 'invalid_request')
  let body: unknown
  try {
    body = await authenticatedJSON(
      `/api/v1/clients/${client}/billing/${id}/pricing-snapshot`,
      signal ? { signal } : {},
    )
  } catch (e) {
    if (e instanceof APIError && e.status === 404) {
      await billingDetail(client, id, signal)
      return null
    }
    throw e
  }
  const s = parseSnapshot(body)
  requireValue(
    s.client_id === client.toLowerCase() &&
      s.collection_id === id.toLowerCase(),
  )
  return s
}
