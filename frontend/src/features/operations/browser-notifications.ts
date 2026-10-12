import { useSyncExternalStore } from 'react'

const event = 'roisey-else.browser-alerts'
const memory = new Map<string, boolean>()
const key = (actor: string) => `roisey-else.browser-alerts.${actor}`
export function browserAlertsSupported() {
  return window.isSecureContext && 'Notification' in window
}
function enabled(actor: string) {
  if (!browserAlertsSupported() || Notification.permission !== 'granted')
    return false
  try {
    return localStorage.getItem(key(actor)) === 'on'
  } catch {
    return memory.get(actor) ?? false
  }
}
function snapshot(actor: string) {
  return `${enabled(actor)}:${browserAlertsSupported() ? Notification.permission : 'unsupported'}`
}
function subscribe(callback: () => void) {
  const events = ['storage', 'focus', 'visibilitychange', event]
  for (const name of events) window.addEventListener(name, callback)
  return () => {
    for (const name of events) window.removeEventListener(name, callback)
  }
}
export function useBrowserAlerts(actor: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot(actor),
    () => 'false:unsupported',
  )
  return {
    enabled: value.startsWith('true:'),
    permission: value.split(':')[1] as NotificationPermission | 'unsupported',
  }
}
function save(actor: string, value: boolean) {
  memory.set(actor, value)
  try {
    localStorage.setItem(key(actor), value ? 'on' : 'off')
  } catch {
    /* Memory-only preference until the tab closes. */
  }
  window.dispatchEvent(new Event(event))
}
export async function enableBrowserAlerts(actor: string) {
  if (!browserAlertsSupported() || Notification.permission === 'denied') return false
  // Called directly by the settings button, never on mount or by polling.
  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
  save(actor, permission === 'granted')
  return permission === 'granted'
}
export function disableBrowserAlerts(actor: string) {
  save(actor, false)
}

export async function claimBrowserAlert(
  actor: string,
  timestamp: string,
  active: () => boolean,
) {
  const claim = () => {
    if (!active() || !enabled(actor)) return false
    // Only a delivery timestamp is retained, never a request title, amount or body.
    const watermarkKey = `${key(actor)}.last`
    try {
      if ((localStorage.getItem(watermarkKey) ?? '') >= timestamp) return false
      localStorage.setItem(watermarkKey, timestamp)
    } catch {
      if (!document.hasFocus()) return false
    }
    return true
  }
  if (navigator.locks)
    return navigator.locks.request(`roisey-else.browser-alerts.${actor}`, claim)
  // Without cross-tab locking, the focused tab is the sole notification sender.
  return document.hasFocus() ? claim() : false
}
