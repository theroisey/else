import { afterEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LanguageControl } from './LanguageControl'
import { localeStorageKey, setLocale } from './index'

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ session: {} }),
}))
afterEach(async () => {
  await act(() => setLocale('en', false))
  localStorage.clear()
  document.cookie = 'else_csrf=; Max-Age=0; Path=/'
  vi.unstubAllGlobals()
})
it('serializes account preference writes across all mounted language selectors', async () => {
  document.cookie = `else_csrf=${'a'.repeat(43)}; Path=/`
  let finish!: (response: Response) => void
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  render(
    <>
      <LanguageControl />
      <LanguageControl />
    </>,
  )
  const controls = screen.getAllByRole('combobox')
  await userEvent.setup().selectOptions(controls[0]!, 'tr')
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  expect(controls[0]).toBeDisabled()
  expect(controls[1]).toBeDisabled()
  // Even a stale/programmatic event from the other control cannot queue a write.
  fireEvent.change(controls[1]!, { target: { value: 'de' } })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () =>
    finish(
      new Response(JSON.stringify({ data: { locale: 'tr' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  await waitFor(() => expect(controls[0]).toBeEnabled())
  expect(controls[1]).toBeEnabled()
  expect(localStorage.getItem(localeStorageKey)).toBe('tr')
  expect(fetcher).toHaveBeenCalledWith(
    '/api/v1/auth/preferences',
    expect.objectContaining({ method: 'PUT', body: '{"locale":"tr"}' }),
  )
})
