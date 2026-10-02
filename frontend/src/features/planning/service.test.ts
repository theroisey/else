import { afterEach, expect, it, vi } from 'vitest'
import * as api from './service'
import {
  defaultFilter,
  emptyMetadata,
  metadataSchema,
  linkSetSchema,
  parseRecord,
  parseCandidates,
  parseLinks,
  planTransitions,
  milestoneTransitions,
} from './models'
import { planningPermissions } from './permissions'
import { safeReturnTo } from '../shell/navigation'
import {
  clientID,
  planID,
  milestoneID,
  taskID,
  otherID,
  plan,
  milestone,
  date,
} from './fixtures.test-data'
const scope = { clientID },
  childScope = { clientID, planID }
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const page = (data: unknown[]) => ({ data, page: { limit: 25, next_cursor: null } })
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('restores only valid planning and milestone destinations', () => {
  const base = `/app/clients/${clientID}/plans`,
    child = base + '/' + planID + '/milestones'
  for (const path of [
    base,
    base + '/new',
    base + '/' + planID,
    base + '/' + planID + '/edit',
    child,
    child + '/new',
    child + '/' + milestoneID,
    child + '/' + milestoneID + '/edit',
  ])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    base + '/new/edit',
    base + '?q=private',
    base + '/bad',
    child + '/new/edit',
    base + '/' + planID + '/edit/new',
    child + '/bad',
    child + '/' + milestoneID + '/edit/extra',
  ])
    expect(safeReturnTo(path)).toBe('/app')
})
it('validates Unicode text, exact dates, state consistency and bounded distinct links', () => {
  expect(
    metadataSchema.parse({ ...emptyMetadata, title: ' Plan ', description: 'one\r\ntwo' }),
  ).toMatchObject({ title: 'Plan', description: 'one\ntwo' })
  for (const bad of [
    { title: '' },
    { title: '世'.repeat(201) },
    { description: 'a\tb' },
    { start_at: 'bad' },
    { start_at: '2026-10-02T00:00:00.000002Z', due_at: '2026-10-02T00:00:00.000001Z' },
  ])
    expect(metadataSchema.safeParse({ ...emptyMetadata, title: 'ok', ...bad }).success).toBe(false)
  expect(metadataSchema.safeParse({ ...emptyMetadata, title: '世'.repeat(200) }).success).toBe(true)
  for (const bad of [[taskID, taskID.toUpperCase()], Array(51).fill(taskID), ['bad']])
    expect(linkSetSchema.safeParse(bad).success).toBe(false)
  expect(linkSetSchema.parse([])).toEqual([])
  for (const change of [
    { status: 'completed' },
    { status: 'planned' },
    { task_ids: [] },
    { completed_at: date },
    { updated_at: '2020-01-01T00:00:00Z' },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => parseRecord({ data: { ...plan, ...change } })).toThrow()
  for (const change of [{ status: 'active' }, { start_at: date }, { task_ids: undefined }])
    expect(() => parseRecord({ data: { ...milestone, ...change } })).toThrow()
  expect(planTransitions.draft).not.toContain('completed')
  expect(planTransitions.completed).toEqual(['active'])
  expect(milestoneTransitions.completed).toEqual(['in_progress'])
})
it('requires planning view alongside writes and separates task/client access', () => {
  const g = (permission: string) => ({ permission, scope: 'client' as const, client_id: clientID })
  for (const p of ['planning.create', 'planning.update', 'planning.archive'])
    expect(planningPermissions([g(p)], clientID)).toMatchObject({
      view: false,
      create: false,
      update: false,
      archive: false,
    })
  expect(planningPermissions([g('planning.view'), g('planning.update')], clientID)).toMatchObject({
    view: true,
    create: false,
    update: true,
    archive: false,
    taskView: false,
    clientView: false,
  })
  expect(planningPermissions([g('planning.view'), g('planning.update')], otherID).view).toBe(false)
})
it('rejects foreign client/plan records and invalid pagination before rendering', async () => {
  const fetcher = vi.fn(() => Promise.resolve(json({ data: { ...milestone, plan_id: otherID } })))
  vi.stubGlobal('fetch', fetcher)
  await expect(api.detail(childScope, milestoneID)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  fetcher.mockResolvedValueOnce(json(page([{ ...plan, client_id: otherID }])))
  await expect(
    api.list(scope, defaultFilter, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  fetcher.mockResolvedValueOnce(
    json({ data: [plan, plan], page: { limit: 25, next_cursor: null } }),
  )
  await expect(
    api.list(scope, defaultFilter, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  await expect(api.detail({ clientID: '../unsafe' }, planID)).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(
    api.list(childScope, { ...defaultFilter, status: 'draft' }, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_request' })
})
it('keeps candidates minimal and link history free of task metadata', () => {
  expect(() =>
    parseCandidates(page([{ id: taskID, title: 'Task', status: 'todo', description: 'private' }])),
  ).toThrow()
  expect(() =>
    parseLinks(
      page([
        { id: otherID, task_id: taskID, linked_at: date, unlinked_at: null, title: 'private' },
      ]),
    ),
  ).toThrow()
  expect(
    parseLinks(page([{ id: otherID, task_id: taskID, linked_at: date, unlinked_at: null }])).data,
  ).toHaveLength(1)
})
it('sends only full metadata or explicit state/link/archive inputs and confirms mutation revisions', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn(() => Promise.resolve(json({ data: { id: milestoneID, revision: 2 } })))
  vi.stubGlobal('fetch', fetcher)
  await api.update(childScope, milestoneID, { ...emptyMetadata, title: ' Changed ' }, 1)
  expect(
    JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
  ).toEqual({ title: 'Changed', description: '', due_at: null, expected_revision: 1 })
  await api.replaceLinks(childScope, milestoneID, [], 1)
  expect(
    JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string),
  ).toEqual({ task_ids: [], expected_revision: 1 })
  fetcher.mockResolvedValueOnce(json({ data: { id: otherID, revision: 2 } }))
  await expect(api.archive(childScope, milestoneID, 1)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  fetcher.mockResolvedValueOnce(json({ data: { id: planID, revision: 1 } }))
  await expect(api.transition(scope, planID, 'active', 1)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  await expect(api.archive(scope, planID, Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(api.replaceLinks(scope, planID, [], 1)).rejects.toMatchObject({
    code: 'invalid_request',
  })
})
it('uses bounded literal filters and dedicated candidate/history parameters', async () => {
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      json(url.includes('task-links') || url.includes('task-candidates') ? page([]) : page([plan])),
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  await api.list(
    scope,
    { ...defaultFilter, q: ' 100% ', archived: 'all', sort: '-id' },
    '',
    new AbortController().signal,
  )
  expect(new URL(fetcher.mock.calls[0]![0], 'https://else.example').searchParams.get('q')).toBe(
    '100%',
  )
  await api.candidates(childScope, '', 'Task', new AbortController().signal)
  await api.links(childScope, milestoneID, '', 'all', new AbortController().signal)
  expect(fetcher.mock.calls[1]![0]).toContain(`/plans/${planID}/task-candidates?limit=25&q=Task`)
  expect(fetcher.mock.calls[2]![0]).toContain(
    `/milestones/${milestoneID}/task-links?limit=25&archived=all`,
  )
  await expect(
    api.list(scope, defaultFilter, 'bad', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_request' })
})
