import { useState } from 'react'
import { Button } from '../../components/ui'
import { Help } from '../../components/ui/Help'
import { copy, useLocale } from '../../i18n'
import { useAuth } from '../auth/auth-context'
import {
  disableBrowserAlerts,
  enableBrowserAlerts,
  useBrowserAlerts,
} from './browser-notifications'

export function BrowserAlerts() {
  useLocale()
  const auth = useAuth()
  const actor = auth.session!.user.id
  const alerts = useBrowserAlerts(actor)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <section className="settings-section">
      <div>
        <p className="eyebrow">{copy('Personal preferences', 'settings')}</p>
        <div className="mt-2 flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            {copy('Browser notifications', 'help')}
          </h2>
          <Help topic="notifications" />
        </div>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
          {copy(
            'Receive a discreet alert for new updates while the panel is open, including in a background tab. Private details stay inside the panel. This is not closed-browser push delivery.',
            'help',
          )}
        </p>
      </div>
      <div className="space-y-4">
        <p role="status" className="text-sm">
          {copy(
            alerts.permission === 'unsupported'
              ? 'Browser notifications require a supported browser and HTTPS.'
              : alerts.permission === 'denied'
                ? 'Notifications are blocked. Allow them in your browser’s site settings to enable alerts.'
                : alerts.enabled
                  ? 'Browser alerts are enabled for this account on this browser.'
                  : 'Browser alerts are disabled.',
            'help',
          )}
        </p>
        <Button
          disabled={
            pending ||
            alerts.permission === 'unsupported' ||
            alerts.permission === 'denied'
          }
          onClick={() => {
            setFailed(false)
            if (alerts.enabled) {
              disableBrowserAlerts(actor)
              return
            }
            setPending(true)
            void enableBrowserAlerts(actor)
              .catch(() => {
                setFailed(true)
              })
              .finally(() => setPending(false))
          }}
        >
          {copy(
            alerts.enabled
              ? 'Disable browser alerts'
              : pending
                ? 'Waiting for browser permission…'
                : 'Enable browser alerts',
            'help',
          )}
        </Button>
        {failed ? (
          <p role="alert" className="text-danger-ink">
            {copy(
              'The browser could not enable alerts. Try again or review its site settings.',
              'help',
            )}
          </p>
        ) : null}
      </div>
    </section>
  )
}
