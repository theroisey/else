import { it, expect, vi } from 'vitest'
import * as api from './service'
import { parseVersion, parseCalculation, parseSnapshot } from './models'
import {
  profile,
  version,
  sheet,
  calculation,
  snapshot,
  clientID,
  sheetID,
  versionID,
  nextID,
  withoutCosts,
} from './fixtures.test-data'
import { collection } from '../billing/fixtures.test-data'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function mock(body: unknown) {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const f = vi.fn().mockResolvedValue(json(body))
  vi.stubGlobal('fetch', f)
  return f
}
it('binds exact preview inputs and verifies its arithmetic', async () => {
  const f = mock({ data: calculation })
  expect((await api.preview(clientID, profile)).total_minor).toBe('125')
  expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual(profile)
  expect(f.mock.calls[0]![1].headers['X-CSRF-Token']).toBe('a'.repeat(43))
  mock({ data: { ...calculation, total_minor: '126' } })
  await expect(api.preview(clientID, profile)).rejects.toMatchObject({
    code: 'invalid_response',
  })
})
it.each([
  'base_minor',
  'discount_minor',
  'net_minor',
  'tax_minor',
  'total_minor',
  'cost_minor',
])('rejects incorrect calculated %s', (field) => {
  expect(() =>
    parseCalculation({ data: { ...calculation, [field]: '999' } }),
  ).toThrow()
})
it('rejects hidden costs before caching and accepts cost-free view-only history', () => {
  expect(() => parseVersion({ data: version }, false)).toThrow()
  expect(parseVersion({ data: withoutCosts(version) }, false).id).toBe(
    versionID,
  )
  expect(() =>
    parseSnapshot({ data: { ...snapshot, cost_minor: '11' } }),
  ).toThrow()
  expect(() =>
    parseSnapshot({ data: { ...snapshot, note: 'private' } }),
  ).toThrow()
})
it('binds client, sheet, selected version and currency', async () => {
  mock({ data: { ...sheet, client_id: nextID } })
  await expect(api.detail(clientID, sheetID, true)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  mock({ data: { ...version, sheet_id: nextID } })
  await expect(
    api.version(clientID, sheetID, versionID, true),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  mock({ data: { ...calculation, currency: 'JPY', currency_exponent: 0 } })
  await expect(api.preview(clientID, profile)).rejects.toMatchObject({
    code: 'invalid_response',
  })
})
it('preserves canonical revision/UUID and exact append boundary', async () => {
  const f = mock({
    data: { id: sheetID, version_id: nextID, revision: '9007199254740994' },
  })
  await api.append(clientID, sheetID, '9007199254740993', profile)
  expect(JSON.parse(f.mock.calls[0]![1].body).expected_revision).toBe(
    '9007199254740993',
  )
  await expect(
    api.append(clientID, sheetID, '9223372036854775807', profile),
  ).rejects.toMatchObject({ code: 'invalid_request' })
})
it('accepts an identical committed copy replay at the current collection revision', async () => {
  const f = mock({
      data: { id: sheetID, revision: '9223372036854775807', replayed: true },
    }),
    input = {
      command_id: nextID,
      billing_date: '2020-02-29',
      due_date: null,
      internal_note: ' Synthetic note ',
    }
  const r = await api.copy(
    clientID,
    sheetID,
    versionID,
    '9007199254740993',
    input,
  )
  expect(r.replayed).toBe(true)
  expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({
    ...input,
    internal_note: 'Synthetic note',
    expected_revision: '9007199254740993',
  })
  mock({ data: { id: sheetID, revision: '2', replayed: false } })
  await expect(
    api.copy(clientID, sheetID, versionID, '1', input),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('confirms accessible manual collection before accepting absent snapshot', async () => {
  const f = mock({})
  f.mockResolvedValueOnce(
    json({ error: { code: 'not_found' } }, 404),
  ).mockResolvedValueOnce(json({ data: collection }))
  expect(await api.snapshot(clientID, collection.id)).toBeNull()
  expect(f).toHaveBeenCalledTimes(2)
  f.mockImplementation(() =>
    Promise.resolve(json({ error: { code: 'not_found' } }, 404)),
  )
  await expect(api.snapshot(clientID, collection.id)).rejects.toMatchObject({
    status: 404,
  })
})
it('rejects malformed windows, line positions, exact numbers and pagination', async () => {
  expect(() =>
    parseVersion({ data: { ...version, window_until: '2019-01-01' } }, true),
  ).toThrow()
  expect(() =>
    parseCalculation({
      data: {
        ...calculation,
        lines: [{ ...calculation.lines[0], position: 2 }],
      },
    }),
  ).toThrow()
  expect(() =>
    parseCalculation({ data: { ...calculation, total_minor: 125 } }),
  ).toThrow()
  mock({ data: [sheet], page: { limit: 25, next_cursor: sheetID } })
  await expect(api.list(clientID, true, '')).rejects.toMatchObject({
    code: 'invalid_response',
  })
  const f = mock({ data: [], page: { limit: 25, next_cursor: null } })
  await expect(api.list(clientID, true, '../')).rejects.toMatchObject({
    code: 'invalid_request',
  })
  expect(f).not.toHaveBeenCalled()
})
