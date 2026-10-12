import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthContext } from '../auth/auth-context'
import { BrowserAlerts } from './BrowserAlerts'
import { claimBrowserAlert, disableBrowserAlerts, enableBrowserAlerts } from './browser-notifications'

const actor = '11111111-1111-4111-8111-111111111111'
const request = vi.fn<() => Promise<NotificationPermission>>()
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: request })
  request.mockReset().mockImplementation(async () => {
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true })
    return 'granted'
  })
})
afterEach(() => { localStorage.clear() })
function setup() {
  render(<AuthContext value={{ status: 'signed-in', expired: false, session: { user: { id: actor, email: 'alerts.fixture@example.com', display_name: 'Synthetic alert reviewer', permissions: [] }, session: { expires_at: '2099-01-01T00:00:00Z' } }, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}><BrowserAlerts /></AuthContext>)
}
it('asks for native permission only on a deliberate click and keeps per-account opt-in', async () => {
  setup()
  expect(request).not.toHaveBeenCalled()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Enable browser alerts' }))
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('status')).toHaveTextContent('Browser alerts are enabled')
  expect(localStorage.getItem(`roisey-else.browser-alerts.${actor}`)).toBe('on')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Disable browser alerts' }))
  expect(screen.getByRole('status')).toHaveTextContent('Browser alerts are disabled')
  expect(request).toHaveBeenCalledTimes(1)
})
it('handles denied permission and unsupported contexts without repeated prompts', async () => {
  Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true })
  setup()
  expect(screen.getByRole('button', { name: 'Enable browser alerts' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('blocked')
  expect(await enableBrowserAlerts(actor)).toBe(false)
  expect(request).not.toHaveBeenCalled()
  vi.stubGlobal('isSecureContext', false)
  expect(await enableBrowserAlerts(actor)).toBe(false)
})
it('deduplicates timestamps under a cross-tab lock, isolates accounts and rejects departed readers', async () => {
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_key, callback) => callback()) } })
  await enableBrowserAlerts(actor)
  const newer = '2026-10-12T12:00:00.000000Z'
  expect(await claimBrowserAlert(actor, newer, () => true)).toBe(true)
  expect(await claimBrowserAlert(actor, newer, () => true)).toBe(false)
  expect(await claimBrowserAlert(actor, '2026-10-12T11:59:59.000000Z', () => true)).toBe(false)
  expect(await claimBrowserAlert(actor, '2026-10-12T12:00:01.000000Z', () => false)).toBe(false)
  expect(await claimBrowserAlert('22222222-2222-4222-8222-222222222222', newer, () => true)).toBe(false)
  disableBrowserAlerts(actor)
  expect(await claimBrowserAlert(actor, '2026-10-12T12:00:02.000000Z', () => true)).toBe(false)
  expect([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).every(value => value === 'off' || value === newer)).toBe(true)
})
