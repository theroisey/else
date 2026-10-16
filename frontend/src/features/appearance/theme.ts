import { useSyncExternalStore } from 'react'

export type Appearance = 'light' | 'dark' | 'system'
const storageKey = 'roisey-else.appearance'
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
const subscribers = new Set<() => void>()
let media: MediaQueryList | undefined
let snapshot = {
  preference,
  resolved: (preference === 'dark' || (preference === 'system' && systemDark())
    ? 'dark'
    : 'light') as 'light' | 'dark',
}
function synchronize() {
  const resolved =
    preference === 'dark' ||
    (preference === 'system' && (media?.matches ?? systemDark()))
      ? 'dark'
      : 'light'
  apply()
  if (snapshot.preference === preference && snapshot.resolved === resolved)
    return
  snapshot = { preference, resolved }
  for (const callback of subscribers) callback()
}
function stored(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return
  preference = readPreference()
  synchronize()
}
function subscribe(callback: () => void) {
  if (!subscribers.size) {
    media = window.matchMedia?.('(prefers-color-scheme: dark)')
    window.addEventListener('storage', stored)
    media?.addEventListener('change', synchronize)
    synchronize()
  }
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
    if (!subscribers.size) {
      window.removeEventListener('storage', stored)
      media?.removeEventListener('change', synchronize)
      media = undefined
    }
  }
}
export function setAppearance(value: Appearance) {
  preference = value
  try {
    localStorage.setItem(storageKey, value)
  } catch {
    /* Retain the session preference. */
  }
  synchronize()
}
export function useAppearance() {
  const selected = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
  return { ...selected, setAppearance }
}
