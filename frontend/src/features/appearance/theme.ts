import { useSyncExternalStore } from 'react'

export type Appearance = 'light' | 'dark' | 'system'
const storageKey = 'roisey-else.appearance'
const changeEvent = 'else:appearance'
function readPreference(): Appearance {
  try {
    const value = localStorage.getItem(storageKey)
    if (value === 'light' || value === 'dark') return value
  } catch {
    /* Storage restrictions must not prevent use of the application. */
  }
  return 'system'
}
let preference = readPreference()
function systemDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
function apply() {
  const dark =
    preference === 'dark' || (preference === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#11110f' : '#f2f0ea')
  document.documentElement.dataset.appearance = preference
}
function subscribe(callback: () => void) {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  function changed() {
    apply()
    callback()
  }
  function stored(event: StorageEvent) {
    if (event.key === storageKey || event.key === null) {
      preference = readPreference()
      changed()
    }
  }
  window.addEventListener(changeEvent, changed)
  window.addEventListener('storage', stored)
  media?.addEventListener('change', changed)
  apply()
  return () => {
    window.removeEventListener(changeEvent, changed)
    window.removeEventListener('storage', stored)
    media?.removeEventListener('change', changed)
  }
}
export function setAppearance(value: Appearance) {
  preference = value
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    /* Retain the session preference. */
  }
  apply()
  window.dispatchEvent(new Event(changeEvent))
}
export function useAppearance() {
  const selected = useSyncExternalStore(
    subscribe,
    () => preference,
    () => 'system' as Appearance,
  )
  const resolved = useSyncExternalStore(
    subscribe,
    () =>
      preference === 'dark' || (preference === 'system' && systemDark())
        ? 'dark'
        : 'light',
    () => 'light',
  )
  return { preference: selected, resolved, setAppearance }
}
