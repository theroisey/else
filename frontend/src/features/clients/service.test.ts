import { afterEach, expect, it, vi } from 'vitest'
import { clients, client, create, update, archive } from './service'
import {
  emptyProfile,
  defaultFilter,
  parseClient,
  parsePage,
  profileSchema,
} from './models'
import { APIError } from '../../services/authenticated'
import { safeReturnTo } from '../shell/navigation'

const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('sends the bounded client contract and verified CSRF writes without arbitrary URLs', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      json({ data: [], page: { limit: 25, next_cursor: null } }),
    )
  vi.stubGlobal('fetch', fetcher)
  await clients(
    { ...defaultFilter, q: '100% & name', tag: ' TAG ', sort: '-id' },
    id,
    new AbortController().signal,
  )
  const params = new URL(
    fetcher.mock.calls[0]![0] as string,
    'http://localhost',
  ).searchParams
  expect(Object.fromEntries(params)).toEqual({
    limit: '25',
    status: 'active',
    sort: '-id',
    q: '100% & name',
    tag: 'tag',
    cursor: id,
  })
  fetcher.mockResolvedValue(json({ data: { id, revision: 1 } }))
  await create({ ...emptyProfile, name: 'Synthetic' })
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/v1/clients',
    expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({ 'X-CSRF-Token': 'a'.repeat(43) }),
    }),
  )
  await expect(client('../secret')).rejects.toBeInstanceOf(APIError)
  await expect(
    clients(
      { ...defaultFilter, q: 'x'.repeat(101) },
      '',
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(APIError)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(safeReturnTo(`/app/clients/${id}/edit`)).toBe(
    `/app/clients/${id}/edit`,
  )
  expect(safeReturnTo('/app/clients/../../secret')).toBe('/app')
  expect(safeReturnTo('//foreign.example')).toBe('/app')
})
it('refuses malformed success, wrong target/revision and unsafe server errors', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi
    .fn()
    .mockResolvedValue(json({ data: { id: other, revision: 2 } }))
  vi.stubGlobal('fetch', fetcher)
  await expect(
    update(id, { ...emptyProfile, name: 'Fixture' }, 1),
  ).rejects.toThrow('Unable to complete')
  fetcher.mockResolvedValue(json({ data: { id, revision: 1 } }))
  await expect(archive(id, 1)).rejects.toThrow('Unable to complete')
  fetcher.mockResolvedValue(
    json(
      {
        error: {
          code: 'internal_error',
          message: 'private SQL profile detail',
        },
      },
      500,
    ),
  )
  await expect(client(id)).rejects.toThrow('Unable to complete')
  expect(() => parseClient({ data: { id } })).toThrow('Invalid client response')
  expect(() =>
    parsePage({ data: [], page: { limit: 1000, next_cursor: null } }),
  ).toThrow()
})
it('normalizes full profiles and rejects unsafe, duplicate or overbounded values', () => {
  const valid = profileSchema.parse({
    ...emptyProfile,
    name: ' Fixture ',
    tags: [' TAG '],
    contacts: [{ name: ' Contact ', email: 'MAIL@EXAMPLE.COM', phone: '' }],
  })
  expect(valid).toMatchObject({
    name: 'Fixture',
    tags: ['tag'],
    contacts: [{ name: 'Contact', email: 'mail@example.com' }],
  })
  for (const change of [
    { name: '' },
    { notes: 'line\nbreak' },
    { website: 'javascript:alert(1)' },
    { website: 'https://name:password@example.com' },
    { website: 'https:example.com' },
    { tags: ['TAG', 'tag'] },
    {
      contacts: Array.from({ length: 21 }, () => ({
        name: 'Contact',
        email: '',
        phone: '',
      })),
    },
  ])
    expect(
      profileSchema.safeParse({ ...emptyProfile, name: 'Fixture', ...change })
        .success,
    ).toBe(false)
})
it('preserves malformed legacy website bytes for read-only display while retaining strict write validation', () => {
  const record = {
    ...emptyProfile,
    id,
    name: 'Synthetic legacy account',
    status: 'active',
    revision: 1,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    archived_at: null,
  }
  for (const website of [
    ' legacy value retained ',
    'javascript:legacy-text',
    'https:example.com',
  ]) {
    expect(parseClient({ data: { ...record, website } }).website).toBe(website)
    expect(
      profileSchema.safeParse({ ...emptyProfile, name: record.name, website })
        .success,
    ).toBe(false)
  }
  for (const website of ['a'.repeat(2049), 'legacy\nvalue'])
    expect(() => parseClient({ data: { ...record, website } })).toThrow(
      'Invalid client response',
    )
})
