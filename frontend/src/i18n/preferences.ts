import { csrfToken } from '../features/auth/auth-service'
import {
  currentLocale,
  localeSelectionVersion,
  setLocale,
  validLocale,
} from './index'
import type { Locale } from './index'

export async function readAccountLocale(
  signal: AbortSignal,
): Promise<Locale | null> {
  const response = await fetch('/api/v1/auth/preferences', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { Accept: 'application/json' },
  })
  if (
    !response.ok ||
    response.headers.get('Content-Type')?.split(';')[0] !== 'application/json'
  )
    throw new Error('Unable to load language preference.')
  const body: unknown = await response.json()
  const locale = (body as { data?: { locale?: unknown } } | null)?.data?.locale
  if (locale !== null && !validLocale(locale))
    throw new Error('Invalid language preference.')
  return locale
}
export async function saveAccountLocale(locale: Locale, signal: AbortSignal) {
  const response = await fetch('/api/v1/auth/preferences', {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken(),
    },
    body: JSON.stringify({ locale }),
  })
  if (
    !response.ok ||
    response.headers.get('Content-Type')?.split(';')[0] !== 'application/json'
  )
    throw new Error('Unable to save language preference.')
  const body: unknown = await response.json()
  if ((body as { data?: { locale?: unknown } } | null)?.data?.locale !== locale)
    throw new Error('Invalid language preference.')
}
export async function applyAccountLocale(signal: AbortSignal) {
  const version = localeSelectionVersion(),
    initial = currentLocale()
  const locale = await readAccountLocale(signal)
  if (
    !signal.aborted &&
    version === localeSelectionVersion() &&
    initial === currentLocale() &&
    locale
  )
    await setLocale(locale)
}
