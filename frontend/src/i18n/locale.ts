// Pure locale state: exact formatting and timezone helpers also run in isolated
// Node processes. They must not import React, browser storage or Vite glob APIs.
export const supportedLocales = ['en', 'tr', 'ro', 'de', 'fr'] as const
export type Locale = (typeof supportedLocales)[number]
let resolved: Locale = 'en'
export function currentLocale(): Locale {
  return resolved
}
export function setResolvedLocale(locale: Locale) {
  resolved = locale
}
