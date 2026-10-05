import { z } from 'zod'
import { en, tr, ro, de, fr } from 'zod/locales'
import { currentLocale } from '../i18n/locale.ts'
const validationLocales = { en: en(), tr: tr(), ro: ro(), de: de(), fr: fr() }

// Every schema imports this configured instance before constructing objects.
// An entrypoint-only setting runs too late for shared production chunks.
z.config({
  jitless: true,
  localeError: (issue) => validationLocales[currentLocale()].localeError(issue),
})

export { z }
