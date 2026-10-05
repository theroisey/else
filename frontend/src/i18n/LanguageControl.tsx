import { useEffect, useRef, useSyncExternalStore } from 'react'
import { copy, languages, languageNames, setLocale, useLocale } from './index'
import type { Locale } from './index'
import { saveAccountLocale } from './preferences'
import { useAuth } from '../features/auth/auth-context'

// Login, account and settings share one pending preference write. Disabling all
// mounted selectors prevents two controls from saving competing choices.
let preferenceState = { pending: false, error: '' }
const preferenceListeners = new Set<() => void>()
const subscribePreference = (notify: () => void) => {
  preferenceListeners.add(notify)
  return () => preferenceListeners.delete(notify)
}
function setPreferenceState(value: typeof preferenceState) {
  preferenceState = value
  for (const notify of preferenceListeners) notify()
}
export function LanguageControl() {
  const locale = useLocale()
  const auth = useAuth()
  const { pending, error } = useSyncExternalStore(
    subscribePreference,
    () => preferenceState,
    () => preferenceState,
  )
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function change(locale: Locale) {
    if (preferenceState.pending) return
    setPreferenceState({ pending: true, error: '' })
    const controller = new AbortController()
    request.current = controller
    let changed = false
    let failure = ''
    try {
      await setLocale(locale)
      changed = true
      if (auth.session) await saveAccountLocale(locale, controller.signal)
    } catch {
      if (!controller.signal.aborted)
        failure = changed
          ? 'The language preference could not be saved to your account. Your browser selection is retained.'
          : 'Unable to load this language. Try again.'
    } finally {
      setPreferenceState({ pending: false, error: failure })
    }
  }
  return (
    <div>
      <label className="appearance-control">
        <span>{copy('Language', 'settings')}</span>
        <select
          aria-label={copy('Language', 'settings')}
          value={locale}
          disabled={pending}
          onChange={(e) => {
            void change(e.target.value as Locale)
          }}
        >
          {languages.map((value) => (
            <option value={value} key={value} lang={value}>
              {languageNames[value]}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="mt-2 text-xs text-danger-ink" role="alert">
          {copy(error, 'settings')}
        </p>
      ) : null}
    </div>
  )
}
export function LanguageSettings() {
  useLocale()
  return (
    <section className="settings-section">
      <div>
        <p className="eyebrow">{copy('Personal preferences', 'settings')}</p>
        <h2 className="mt-2 text-lg font-semibold">
          {copy('Language', 'settings')}
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
          {copy(
            'Choose your interface language. Your account preference follows you across devices. Financial currencies and your own content remain unchanged.',
            'settings',
          )}
        </p>
      </div>
      <LanguageControl />
    </section>
  )
}
