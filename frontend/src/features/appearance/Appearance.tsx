import { useAppearance } from './theme'
import type { Appearance } from './theme'

export function AppearanceControl() {
  const { preference, setAppearance } = useAppearance()
  return <label className="appearance-control"><span>Appearance</span><select aria-label="Appearance" value={preference} onChange={event => setAppearance(event.target.value as Appearance)}>
    <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
  </select></label>
}
export function AppearanceSettings() {
  const { preference, resolved, setAppearance } = useAppearance()
  return <section className="settings-section" aria-labelledby="appearance-title">
    <div><p className="eyebrow">Personal preferences</p><h2 id="appearance-title" className="mt-2 text-lg font-semibold">Appearance</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted">Choose the light or dark workspace, or follow your device. Your preference is saved in this browser.</p></div>
    <div><fieldset className="appearance-options"><legend className="sr-only">Workspace appearance</legend>{(['light', 'dark', 'system'] as const).map(mode => <label key={mode} className={`appearance-option ${preference === mode ? 'is-selected' : ''}`}>
      <span className={`appearance-sample appearance-sample-${mode}`} aria-hidden="true"><span /><span /><span /></span>
      <span className="flex items-center justify-between gap-2"><span>{mode.charAt(0).toUpperCase() + mode.slice(1)}</span><input type="radio" name="appearance" value={mode} checked={preference === mode} onChange={() => setAppearance(mode)} /></span>
    </label>)}</fieldset><p className="mt-3 text-xs text-muted">{preference === 'system' ? `Following your device · ${resolved} theme` : `${preference === 'light' ? 'Light' : 'Dark'} theme selected`}</p></div>
  </section>
}
