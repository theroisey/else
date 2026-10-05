import { formatNumber } from './format'
import { currentLocale, setResolvedLocale, supportedLocales } from './locale'
import type { Locale } from './locale'
export { currentLocale } from './locale'
export type { Locale } from './locale'
import { createInstance } from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { useSyncExternalStore } from 'react'

export const languages = supportedLocales
export const languageNames: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ro: 'Română',
  de: 'Deutsch',
  fr: 'Français',
}
export const localeStorageKey = 'roisey-else.locale'
const canonical = import.meta.glob('./locales/en/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, string>>
const loaders = import.meta.glob('./locales/{tr,ro,de,fr}/*.json', {
  import: 'default',
})
const english = Object.fromEntries(
  Object.entries(canonical).map(([path, resource]) => [
    path.split('/').at(-1)!.replace('.json', ''),
    resource,
  ]),
)
export const i18n = createInstance()
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: [...languages],
  resources: { en: english },
  ns: Object.keys(english),
  defaultNS: 'common',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
  react: { useSuspense: false },
})
export function validLocale(value: unknown): value is Locale {
  return typeof value === 'string' && languages.includes(value as Locale)
}
export function resolveLocale(
  stored: unknown,
  browser: readonly string[] = navigator.languages,
): Locale {
  if (validLocale(stored)) return stored
  for (const value of browser) {
    const base = value.toLowerCase().split('-')[0]
    if (validLocale(base)) return base
  }
  return 'en'
}
function browserLocale(): Locale {
  try {
    return resolveLocale(localStorage.getItem(localeStorageKey))
  } catch {
    return resolveLocale(null)
  }
}
let intent = 0
let selectionVersion = 0
const loaded = new Map<Locale, Promise<void>>()
export async function loadLocale(locale: Locale) {
  if (locale === 'en') return
  let pending = loaded.get(locale)
  if (!pending) {
    pending = Promise.all(
      Object.keys(english).map(async (ns) => {
        const load = loaders[`./locales/${locale}/${ns}.json`]
        if (!load) throw new Error('Language resources are unavailable.')
        const resource = await load()
        i18n.addResourceBundle(locale, ns, resource, true, true)
      }),
    ).then(() => undefined)
    loaded.set(locale, pending)
    pending.catch(() => loaded.delete(locale))
  }
  return pending
}
export async function setLocale(locale: Locale, persist = true) {
  if (!validLocale(locale)) throw new Error('Language is invalid.')
  const request = ++intent
  // Record the choice before resource loading; a late account response must not
  // supersede a user selection that is still awaiting its language chunks.
  if (persist) selectionVersion++
  await loadLocale(locale)
  if (request !== intent) return
  await i18n.changeLanguage(locale)
  document.documentElement.lang = locale
  if (persist) {
    try {
      localStorage.setItem(localeStorageKey, locale)
    } catch {
      /* Device storage can be restricted. */
    }
  }
}
export function localeSelectionVersion() {
  return selectionVersion
}
export async function initializeLocale() {
  await setLocale(browserLocale(), false)
}
// English source copy is the message identifier (flat gettext-style keys).
// Missing resources return source copy, never a machine key or blank content.
export function copy(
  source: string,
  ns?: string,
  values?: Record<string, unknown>,
): string
export function copy(
  source: string | undefined,
  ns?: string,
  values?: Record<string, unknown>,
): string | undefined
export function copy(
  source: string | undefined,
  ns = 'common',
  values: Record<string, unknown> = {},
): string | undefined {
  if (source === undefined) return undefined
  const bounded =
    /^Use (1–|up to )(\d+) characters( without control characters\.|; only line breaks are supported\.| with line breaks only\.)$/.exec(
      source,
    )
  if (bounded) {
    values = { ...values, maximum: formatNumber(bounded[2]!) }
    source = `Use ${bounded[1]}{{maximum}} characters${bounded[3]}`
  }
  const scale =
    /^Use at most ([023]) decimal places for (USD|EUR|GBP|TRY|JPY|KWD)\. Amounts are never rounded\.$/.exec(
      source,
    )
  if (scale) {
    values = { ...values, maximum: Number(scale[1]), currency: scale[2] }
    source =
      'Use at most {{maximum}} decimal places for {{currency}}. Amounts are never rounded.'
  }
  const selectedNS = Object.hasOwn(english[ns] ?? {}, source)
    ? ns
    : (Object.keys(english).find((name) =>
        Object.hasOwn(english[name] ?? {}, source),
      ) ?? ns)
  return i18n.t(source, {
    ns: selectedNS,
    defaultValue: source,
    ...Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'number' && Number.isFinite(value)
          ? formatNumber(value)
          : value,
      ]),
    ),
  })
}
export function useLocale() {
  useTranslation(undefined, { i18n })
  return currentLocale()
}
const subscribers = new Set<() => void>()
i18n.on('languageChanged', (language) => {
  setResolvedLocale(validLocale(language) ? language : 'en')
  for (const notify of subscribers) notify()
})
export function useLocaleSnapshot() {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    currentLocale,
    () => 'en' as Locale,
  )
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === localeStorageKey || event.key === null) {
      selectionVersion++
      void setLocale(browserLocale(), false).catch(() => {
        /* Keep the current usable language if chunks cannot load. */
      })
    }
  })
