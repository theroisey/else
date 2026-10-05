import { expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../../app/App'
import { createQueryClient } from '../../app/query-client'
import { sessionKey } from '../auth/session'
import type { Session } from '../auth/session'
import {
  identity,
  report,
  revision,
  stamp,
  unavailable,
} from './fixtures.test-data'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function setup(
  session: Session = identity,
  read: () => Response | Promise<Response> = () => json(report()),
) {
  let current = session
  let expired = false
  const fetcher = vi.fn((path: string, init: RequestInit) => {
    if (path === '/api/v1/auth/preferences')
      return Promise.resolve(json({ data: { locale: null } }))
    if (path === '/api/v1/auth/session')
      return Promise.resolve(
        expired
          ? json({ error: { code: 'authentication_required' } }, 401)
          : json({ data: current }),
      )
    if (path === '/api/v1/releases' && init.method === 'GET')
      return Promise.resolve(read())
    throw new Error('Unexpected fixture request')
  })
  vi.stubGlobal('fetch', fetcher)
  const cache = createQueryClient()
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={['/app/releases']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    cache,
    fetcher,
    expire: () => {
      expired = true
    },
    current: (next: Session) => {
      current = next
    },
    setSession: (next: Session) => {
      current = next
      cache.setQueryData(sessionKey, { session: next, expired: false })
    },
  }
}

it('shows complete API identity and separate unavailable evidence with one shared read', async () => {
  const { fetcher } = setup()
  await screen.findByText(stamp.version)
  expect(screen.getByText(revision, { exact: true })).toBeVisible()
  expect(screen.getByText('2026-10-03 18:00:00 UTC')).toBeVisible()
  expect(
    screen.getAllByText(
      'Configure server-only GitHub credentials to connect release evidence.',
    )[0],
  ).toBeVisible()
  expect(
    screen.getByText(
      'No production deployment evidence source is connected. Artifact publication does not prove a rollout.',
    ),
  ).toBeVisible()
  expect(
    screen.getByRole('link', { name: 'Release Center: API aaaaaaa' }),
  ).toBeVisible()
  expect(
    fetcher.mock.calls.filter(([path]) => path === '/api/v1/releases'),
  ).toHaveLength(1)
  expect(
    fetcher.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET'),
  ).toBe(true)
})

it('denies absent and client-only grants without a release request', async () => {
  const { fetcher } = setup({
    ...identity,
    user: {
      ...identity.user,
      permissions: [
        {
          permission: 'releases.view',
          scope: 'client',
          client_id: '22222222-2222-4222-8222-222222222222',
        },
      ],
    },
  })
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(fetcher.mock.calls.some(([path]) => path === '/api/v1/releases')).toBe(
    false,
  )
  expect(
    screen.queryByRole('link', { name: /Release Center/ }),
  ).not.toBeInTheDocument()
})

it('handles unavailable build and safe manual recovery from malformed or failed data', async () => {
  let next = json(report(unavailable))
  setup(identity, () => next)
  await screen.findByText(
    'This API binary has no valid embedded build metadata.',
  )
  next = json({ data: 'synthetic-private-diagnostic' })
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Refresh release information' }),
  )
  await screen.findByRole('alert')
  expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument()
  next = json(report())
  await user.click(
    screen.getByRole('button', { name: 'Refresh release information' }),
  )
  await screen.findByText(stamp.version)
  next = json(
    {
      error: {
        code: 'internal_error',
        message: 'synthetic-private-diagnostic',
      },
    },
    500,
  )
  await user.click(
    screen.getByRole('button', { name: 'Refresh release information' }),
  )
  await screen.findByRole('alert')
  expect(screen.queryByText(stamp.version)).not.toBeInTheDocument()
})

it('removes current metadata and navigation after real permission failure refreshes grants', async () => {
  let denied = false
  const fixture = setup(identity, () =>
    denied
      ? json({ error: { code: 'permission_denied' } }, 403)
      : json(report()),
  )
  await screen.findByText(stamp.version)
  denied = true
  fixture.current({ ...identity, user: { ...identity.user, permissions: [] } })
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh release information' }))
  await screen.findByRole('heading', { name: 'Access denied' })
  expect(screen.queryByText(stamp.version)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: /Release Center/ }),
  ).not.toBeInTheDocument()
})

it('discards a delayed old identity response after session context changes', async () => {
  let resolve!: (response: Response) => void
  const delayed = new Promise<Response>((done) => {
    resolve = done
  })
  let calls = 0
  const fixture = setup(identity, () =>
    ++calls === 1
      ? delayed
      : json(
          report({
            ...stamp,
            version: 'sha-' + 'b'.repeat(40),
            commit_sha: 'b'.repeat(40),
          }),
        ),
  )
  await waitFor(() => expect(calls).toBe(1))
  await act(async () =>
    fixture.setSession({
      ...identity,
      user: { ...identity.user, id: '33333333-3333-4333-8333-333333333333' },
    }),
  )
  await screen.findByText('sha-' + 'b'.repeat(40))
  await act(async () => resolve(json(report())))
  expect(screen.queryByText(stamp.version)).not.toBeInTheDocument()
  expect(screen.getByText('sha-' + 'b'.repeat(40))).toBeVisible()
})

it('clears protected metadata when the server reports an ended session', async () => {
  let expired = false
  const fixture = setup(identity, () =>
    expired
      ? json({ error: { code: 'authentication_required' } }, 401)
      : json(report()),
  )
  await screen.findByText(stamp.version)
  expired = true
  fixture.expire()
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh release information' }))
  await screen.findByRole('heading', { name: 'Sign in' })
  expect(screen.queryByText(stamp.version)).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: /Release Center/ }),
  ).not.toBeInTheDocument()
})

it('renders real artifact fields and partial provenance without claiming deployment or signature verification', async () => {
  const artifact = {
    commit_sha: revision,
    tag: 'sha-' + revision,
    digest: 'sha256:' + 'c'.repeat(64),
    image_reference: 'ghcr.io/theroisey/else@sha256:' + 'c'.repeat(64),
    built_at: stamp.built_at,
    published_at: null,
    source: 'github_ghcr',
  }
  const result = {
    data: {
      ...report().data,
      latest_release: { status: 'available', artifact },
      image_provenance: {
        status: 'available',
        artifact,
        attestation: { status: 'present', reason: 'signature_not_verified' },
      },
    },
  }
  const { fetcher } = setup(identity, () => json(result))
  await screen.findByText('Published artifact identified')
  expect(screen.getByText('Image metadata matched')).toBeVisible()
  expect(
    screen.getByText(
      'A digest-matching attestation is present. Its signature has not been verified by this application.',
    ),
  ).toBeVisible()
  expect(screen.getAllByText(artifact.digest)).toHaveLength(2)
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Refresh release information' }))
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([path]) => path === '/api/v1/releases'),
    ).toHaveLength(2),
  )
  expect(
    fetcher.mock.calls
      .filter(([path]) => path === '/api/v1/releases')
      .at(-1)?.[1].headers,
  ).toMatchObject({ 'X-Release-Refresh': 'revalidate' })
})

it('keeps runtime metadata readable during a safely classified GitHub outage', async () => {
  setup(identity, () =>
    json({
      data: {
        ...report().data,
        latest_release: {
          status: 'unavailable',
          reason: 'authentication_failed',
        },
        image_provenance: { status: 'unavailable', reason: 'access_denied' },
      },
    }),
  )
  await screen.findByText(stamp.version)
  expect(
    screen.getByText(
      'The GitHub credential is invalid or expired. Update the server credential.',
    ),
  ).toBeVisible()
  expect(
    screen.getByText(
      'The credential cannot read this evidence. Check repository and package read permissions.',
    ),
  ).toBeVisible()
})
