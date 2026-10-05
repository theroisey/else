import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceControl, AppearanceSettings } from './Appearance'
import { setAppearance } from './theme'

let dark = false
let changes: EventTarget
beforeEach(() => {
  dark = false
  changes = new EventTarget()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return dark },
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: changes.removeEventListener.bind(changes),
  })))
  setAppearance('system')
  localStorage.clear()
})
afterEach(() => { setAppearance('system'); localStorage.clear() })
it('persists explicit selection, shares controls and follows device changes only in System', async () => {
  render(<><AppearanceControl /><AppearanceSettings /></>)
  const user = userEvent.setup()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), 'dark')
  expect(document.documentElement).toHaveClass('dark')
  expect(localStorage.getItem('roisey-else.appearance')).toBe('dark')
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  act(() => changes.dispatchEvent(new Event('change')))
  expect(document.documentElement).toHaveClass('dark')
  await user.click(screen.getByRole('radio', { name: 'System' }))
  expect(document.documentElement).not.toHaveClass('dark')
  act(() => { dark = true; changes.dispatchEvent(new Event('change')) })
  expect(document.documentElement).toHaveClass('dark')
  expect(screen.getByText('Following your device · dark theme')).toBeVisible()
})
it('synchronizes a preference change from another tab and ignores unrelated storage', () => {
  render(<AppearanceControl />)
  act(() => { localStorage.setItem('roisey-else.appearance', 'dark'); window.dispatchEvent(new StorageEvent('storage', { key: 'roisey-else.appearance' })) })
  expect(document.documentElement).toHaveClass('dark')
  expect(screen.getByRole('combobox')).toHaveValue('dark')
  act(() => { localStorage.setItem('roisey-else.appearance', 'untrusted-value'); window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })) })
  expect(screen.getByRole('combobox')).toHaveValue('dark')
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'roisey-else.appearance' })))
  expect(screen.getByRole('combobox')).toHaveValue('system')
  expect(document.documentElement).not.toHaveClass('dark')
})
it('keeps appearance controls usable when persistence is unavailable', async () => {
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
  render(<AppearanceControl />)
  await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'dark')
  expect(document.documentElement).toHaveClass('dark')
  expect(screen.getByRole('combobox')).toHaveValue('dark')
  save.mockRestore()
})
