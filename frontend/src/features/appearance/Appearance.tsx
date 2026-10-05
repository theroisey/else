import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useAppearance } from './theme'
import type { Appearance } from './theme'

export function AppearanceControl() {
  useLocale()
  const { preference, setAppearance } = useAppearance()
  return (
    <label className="appearance-control">
      <span>{copy('Appearance', 'settings')}</span>
      <select
        aria-label={copy('Appearance', 'settings')}
        value={preference}
        onChange={(event) => setAppearance(event.target.value as Appearance)}
      >
        <option value="light">{copy('Light', 'settings')}</option>
        <option value="dark">{copy('Dark', 'settings')}</option>
        <option value="system">{copy('System', 'settings')}</option>
      </select>
    </label>
  )
}
export function AppearanceSettings() {
  useLocale()
  const { preference, resolved, setAppearance } = useAppearance()
  return (
    <section className="settings-section" aria-labelledby="appearance-title">
      <div>
        <p className="eyebrow">{copy('Personal preferences', 'settings')}</p>
        <h2 id="appearance-title" className="mt-2 text-lg font-semibold">
          {copy('Appearance', 'settings')}
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
          {copy(
            'Choose the light or dark workspace, or follow your device. Your preference is saved in this browser.',
            'settings',
          )}
        </p>
      </div>
      <div>
        <fieldset className="appearance-options">
          <legend className="sr-only">
            {copy('Workspace appearance', 'settings')}
          </legend>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <label
              key={mode}
              className={`appearance-option ${preference === mode ? 'is-selected' : ''}`}
            >
              <span
                className={`appearance-sample appearance-sample-${mode}`}
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </span>
              <span className="flex items-center justify-between gap-2">
                <span>{statusLabel(mode)}</span>
                <input
                  type="radio"
                  name="appearance"
                  value={mode}
                  checked={preference === mode}
                  onChange={() => setAppearance(mode)}
                />
              </span>
            </label>
          ))}
        </fieldset>
        <p className="mt-3 text-xs text-muted">
          {preference === 'system'
            ? copy('Following your device · {{value1}} theme', 'settings', {
                value1: statusLabel(resolved),
              })
            : copy('{{value1}} theme selected', 'settings', {
                value1: statusLabel(preference),
              })}
        </p>
      </div>
    </section>
  )
}
