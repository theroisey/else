import { afterEach, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
} from '@tanstack/react-query'
import { createQueryClient } from '../../app/query-client'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './auth-context'
import type { Session } from './session'
import * as service from './auth-service'

vi.mock('./auth-service', () => ({
  currentSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))
vi.mock('../../i18n/preferences', () => ({
  applyAccountLocale: vi.fn().mockResolvedValue(undefined),
}))
const identity: Session = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'idle.fixture@example.com',
    display_name: 'Synthetic session reader',
    permissions: [{ permission: 'clients.view', scope: 'global' }],
  },
  session: { expires_at: '2099-01-01T00:00:00Z' },
}
function Probe() {
  const auth = useAuth()
  return <p>{auth.status}</p>
}
function setup() {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return client
}
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
}
afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
})
it('does no fixed session polling while a signed-in browser is idle', async () => {
  vi.useFakeTimers()
  vi.mocked(service.currentSession).mockResolvedValue(identity)
  setup()
  await flush()
  expect(screen.getByText('signed-in')).toBeVisible()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000)
  })
  expect(service.currentSession).toHaveBeenCalledTimes(1)
})
it('revalidates on focus and reconnect and clears a revoked identity', async () => {
  vi.useFakeTimers()
  vi.mocked(service.currentSession).mockResolvedValue(identity)
  const client = setup()
  await flush()
  client.setQueryData(['private', 'fixture'], 'private data')
  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
  await flush()
  expect(service.currentSession).toHaveBeenCalledTimes(2)
  vi.mocked(service.currentSession).mockResolvedValue(null)
  await act(async () => {
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
  })
  await flush()
  expect(service.currentSession).toHaveBeenCalledTimes(3)
  expect(screen.getByText('signed-out')).toBeVisible()
  expect(client.getQueryData(['private', 'fixture'])).toBeUndefined()
})
