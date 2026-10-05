import { afterEach, expect, it, vi } from 'vitest'
import * as api from './service'
import {
  emptyMetadata,
  defaultFilter,
  metadataSchema,
  parseTask,
  transitions,
} from './models'
import { taskPermissions } from './permissions'
import { safeReturnTo } from '../shell/navigation'
import { clientID, taskID, otherID, task } from './fixtures.test-data'

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
afterEach(() => {
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
})
it('restores validated task deep links without accepting filters or malformed paths', () => {
  const base = `/app/clients/${clientID}/tasks`
  for (const path of [
    base,
    base + '/new',
    base + '/' + taskID,
    base + '/' + taskID + '/edit',
  ])
    expect(safeReturnTo(path)).toBe(path)
  for (const path of [
    base + '/new/edit',
    base + '?q=private',
    base + '/bad',
    base + '/../edit',
  ])
    expect(safeReturnTo(path)).toBe('/app')
})
it('validates normalized metadata, Unicode, plain text, tags and ordered instants', () => {
  const parsed = metadataSchema.parse({
    ...emptyMetadata,
    title: ' Synthetic ',
    description: ' one\r\ntwo ',
    tags: [' WORK '],
  })
  expect(parsed).toMatchObject({
    title: 'Synthetic',
    description: 'one\ntwo',
    tags: ['work'],
  })
  for (const bad of [
    { title: '' },
    { title: 'x'.repeat(201) },
    { description: 'bad\ttext' },
    { tags: ['same', ' SAME '] },
    { priority: 'critical' },
    { assignee_id: 'bad' },
    { start_at: 'bad', due_at: 'bad' },
    {
      start_at: '2026-10-02T12:00:00.000002Z',
      due_at: '2026-10-02T12:00:00.000001Z',
    },
  ])
    expect(
      metadataSchema.safeParse({ ...emptyMetadata, title: 'Synthetic', ...bad })
        .success,
    ).toBe(false)
  expect(transitions.todo).not.toContain('done')
  expect(transitions.done).toEqual(['in_progress'])
  expect(transitions.cancelled).toEqual(['backlog', 'todo'])
})
it('fails closed for state/timestamp inconsistencies and foreign-client responses', async () => {
  for (const change of [
    { status: 'done' },
    { status: 'cancelled' },
    { completed_at: task.created_at },
    { updated_at: 'bad' },
    { updated_at: '2020-01-01T00:00:00Z' },
    { status: 'unknown' },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(() => parseTask({ data: { ...task, ...change } })).toThrow(
      'Unable to complete',
    )
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(json({ data: { ...task, client_id: otherID } })),
    ),
  )
  await expect(api.detail(clientID, taskID)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        json({
          data: [{ ...task, client_id: otherID }],
          page: { limit: 25, next_cursor: null },
        }),
      ),
    ),
  )
  await expect(
    api.list(clientID, defaultFilter, '', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})
it('sends bounded exact-client filters and refuses malformed paths/queries', async () => {
  const fetcher = vi.fn((url: string) => {
    expect(url).toContain(`/api/v1/clients/${clientID}/tasks?`)
    return Promise.resolve(
      json({ data: [task], page: { limit: 25, next_cursor: null } }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  await api.list(
    clientID,
    {
      ...defaultFilter,
      q: '100%',
      tag: ' WORK ',
      assignee: 'unassigned',
      status: 'todo',
    },
    '',
    new AbortController().signal,
  )
  const query = new URL(fetcher.mock.calls[0]![0] as string, 'http://localhost')
    .searchParams
  expect(Object.fromEntries(query)).toEqual({
    limit: '25',
    status: 'todo',
    priority: 'all',
    archived: 'false',
    sort: 'id',
    q: '100%',
    tag: 'work',
    assignee: 'unassigned',
  })
  await expect(api.detail('../unsafe', taskID)).rejects.toMatchObject({
    code: 'invalid_request',
  })
  await expect(
    api.list(clientID, defaultFilter, 'bad', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(
    api.list(
      clientID,
      { ...defaultFilter, q: 'x'.repeat(101) },
      '',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('confirms mutation ID/revision and sends only metadata or explicit transition fields', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    expect(url).toContain(`/api/v1/clients/${clientID}/tasks/${taskID}`)
    expect(init.credentials).toBe('same-origin')
    return Promise.resolve(json({ data: { id: taskID, revision: 2 } }))
  })
  vi.stubGlobal('fetch', fetcher)
  await api.transition(clientID, taskID, 'in_progress', 1)
  expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({
    status: 'in_progress',
    expected_revision: 1,
  })
  fetcher.mockResolvedValueOnce(json({ data: { id: otherID, revision: 2 } }))
  await expect(api.archive(clientID, taskID, 1)).rejects.toMatchObject({
    code: 'invalid_response',
  })
  fetcher.mockResolvedValueOnce(json({ data: { id: taskID, revision: 1 } }))
  await expect(
    api.update(clientID, taskID, { ...emptyMetadata, title: 'Updated' }, 1),
  ).rejects.toMatchObject({ code: 'invalid_response' })
  await expect(
    api.archive(clientID, taskID, Number.MAX_SAFE_INTEGER),
  ).rejects.toMatchObject({
    code: 'invalid_request',
  })
})
it('requires exact task view before granular or legacy actions', () => {
  const scoped = (permission: string) => ({
    permission,
    scope: 'client' as const,
    client_id: clientID,
  })
  expect(taskPermissions([scoped('tasks.manage')], clientID)).toMatchObject({
    view: false,
    create: false,
    update: false,
    archive: false,
  })
  expect(
    taskPermissions([scoped('tasks.view'), scoped('tasks.manage')], clientID),
  ).toMatchObject({
    view: true,
    create: true,
    update: true,
    archive: true,
  })
  expect(
    taskPermissions([scoped('tasks.view'), scoped('tasks.create')], clientID),
  ).toMatchObject({
    view: true,
    create: true,
    update: false,
    archive: false,
  })
  expect(
    taskPermissions([scoped('tasks.view'), scoped('tasks.delete')], clientID),
  ).toMatchObject({
    view: true,
    create: false,
    update: false,
    archive: true,
  })
  expect(
    taskPermissions([scoped('tasks.view'), scoped('tasks.manage')], otherID)
      .view,
  ).toBe(false)
})
