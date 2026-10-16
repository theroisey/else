import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from '../../lib/validation'
import { authenticatedJSON } from '../../services/authenticated'
import { Button, TextField, PageSkeleton } from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { LanguageSettings } from '../../i18n/LanguageControl'
import { AppearanceSettings } from '../appearance/Appearance'
import { BrowserAlerts } from './BrowserAlerts'
import { hasPermission } from '../auth/permissions'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsHeader, OperationsError } from './Shared'
import { data } from './models'
import {
  preferencesSchema as prefs,
  settingsSchema as settings,
  businessSettings,
} from './preferences-service'
export function SettingsPage() {
  useLocale()
  const op = useRecordOperations('operations')
  const can = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'settings.manage',
    scope: 'global',
  })
  const preferences = useQuery({
    queryKey: [...op.key, 'preferences'],
    queryFn: ({ signal }) =>
      op.read(async () =>
        data(prefs, await authenticatedJSON('/api/v1/preferences', { signal })),
      ),
  })
  const org = useQuery({
    queryKey: [...op.key, 'business-settings'],
    queryFn: ({ signal }) => op.read(() => businessSettings(signal)),
    enabled: can,
  })
  return (
    <section>
      <OperationsHeader title={copy('Settings', 'common')} />
      <AppearanceSettings />
      <LanguageSettings />
      <BrowserAlerts />
      {preferences.isPending ? (
        <PageSkeleton label={copy('Loading preferences…', 'operations')} />
      ) : preferences.isError ? (
        <OperationsError
          error={preferences.error}
          retry={() => {
            void preferences.refetch()
          }}
        />
      ) : (
        <PreferencesForm
          key={preferences.data.revision}
          baseline={preferences.data}
        />
      )}
      {can ? (
        org.isPending ? (
          <PageSkeleton label={copy('Loading preferences…', 'operations')} />
        ) : org.isError ? (
          <OperationsError
            error={org.error}
            retry={() => {
              void org.refetch()
            }}
          />
        ) : (
          <BusinessForm key={org.data.revision} baseline={org.data} />
        )
      ) : null}
    </section>
  )
}
function PreferencesForm({ baseline }: { baseline: z.infer<typeof prefs> }) {
  const op = useRecordOperations('operations')
  const [value, setValue] = useState(baseline)
  const [saved, setSaved] = useState(false)
  return (
    <section className="settings-section">
      <div>
        <p className="eyebrow">{copy('Personal preferences', 'settings')}</p>
        <h2 className="mt-2 text-lg font-semibold">
          {copy('Notifications', 'operations')}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted">
          {copy(
            'Preferences apply to future notifications. Existing history and pending reviews remain.',
            'operations',
          )}
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void op
            .run(async () =>
              data(
                prefs,
                await authenticatedJSON('/api/v1/preferences', {
                  method: 'PUT',
                  body: {
                    workflow: value.workflow,
                    tasks: value.tasks,
                    finance: value.finance,
                    expected_revision: baseline.revision,
                  },
                }),
              ),
            )
            .then((r) => {
              if (r) setSaved(true)
            })
        }}
      >
        <fieldset disabled={op.pending} className="space-y-4">
          {(['workflow', 'tasks', 'finance'] as const).map((key) => (
            <label className="flex items-center gap-3 text-sm" key={key}>
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) =>
                  setValue({ ...value, [key]: e.target.checked })
                }
              />
              {copy(
                key === 'workflow'
                  ? 'Request and delivery updates'
                  : key === 'tasks'
                    ? 'Task deadlines and recurrence'
                    : 'Authorized financial updates',
                'operations',
              )}
            </label>
          ))}
        </fieldset>
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        {saved ? (
          <p role="status">{copy('Preferences saved.', 'operations')}</p>
        ) : null}
        <Button type="submit" disabled={op.pending}>
          {copy('Save', 'operations')}
        </Button>
      </form>
    </section>
  )
}
function BusinessForm({ baseline }: { baseline: z.infer<typeof settings> }) {
  const op = useRecordOperations('operations')
  const [timezone, setTimezone] = useState(baseline.timezone)
  return (
    <section className="settings-section">
      <div>
        <p className="eyebrow">{copy('Organization', 'operations')}</p>
        <h2 className="mt-2 text-lg font-semibold">
          {copy('Business timezone', 'operations')}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted">
          {copy(
            'New schedules use this default. Existing schedules retain their recorded timezone.',
            'operations',
          )}
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void op.run(async () =>
            data(
              settings,
              await authenticatedJSON('/api/v1/operations-settings', {
                method: 'PUT',
                body: { timezone, expected_revision: baseline.revision },
              }),
            ),
          )
        }}
      >
        <TextField
          required
          label={copy('Timezone', 'operations')}
          maxLength={100}
          value={timezone}
          disabled={op.pending}
          onChange={(e) => setTimezone(e.target.value)}
        />
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        <Button type="submit" disabled={op.pending}>
          {copy('Save', 'operations')}
        </Button>
      </form>
    </section>
  )
}
