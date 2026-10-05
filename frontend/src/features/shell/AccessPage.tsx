import { copy, useLocale } from '../../i18n/index'
import { LanguageSettings } from '../../i18n/LanguageControl'
import { faArrowRotateRight } from '@fortawesome/free-solid-svg-icons'
import { useIsFetching } from '@tanstack/react-query'
import { AppearanceSettings } from '../appearance/Appearance'
import { Button, Status, Table, PageHeader } from '../../components/ui'
import { useAuth } from '../auth/auth-context'
import { sessionKey } from '../auth/session'

export function AccessPage() {
  useLocale()
  const auth = useAuth()
  const checking = useIsFetching({ queryKey: sessionKey }) > 0
  const grants = auth.session?.user.permissions ?? []
  return (
    <section className="max-w-5xl">
      <PageHeader
        eyebrow={copy('Account', 'common')}
        title={copy('My access', 'common')}
        description={copy(
          'Your workspace preferences and effective account permissions.',
          'common',
        )}
      >
        <Button
          icon={faArrowRotateRight}
          loading={checking}
          loadingLabel={copy('Refreshing access', 'common')}
          onClick={() => {
            void auth.refresh()
          }}
        >
          {copy('Refresh access', 'common')}
        </Button>
      </PageHeader>
      <AppearanceSettings />
      <LanguageSettings />
      <h2 className="mb-2 text-lg font-semibold">
        {copy('Effective permissions', 'common')}
      </h2>
      <p className="text-sm text-muted">
        {copy('Client access applies only within its listed scope.', 'common')}
      </p>
      <div className="mt-7">
        {grants.length ? (
          <Table caption={copy('Your effective permissions', 'common')}>
            <thead>
              <tr>
                <th scope="col">{copy('Permission', 'common')}</th>
                <th scope="col">{copy('Scope', 'common')}</th>
                <th scope="col">{copy('Client', 'common')}</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr
                  key={`${grant.permission}:${grant.scope}:${grant.client_id ?? ''}`}
                >
                  <th
                    scope="row"
                    className="whitespace-nowrap font-mono text-xs"
                  >
                    {grant.permission}
                  </th>
                  <td>
                    <Status>
                      {grant.scope === 'global'
                        ? copy('Global', 'common')
                        : copy('Client', 'common')}
                    </Status>
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs text-muted">
                    {grant.client_id ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="rounded-md border border-line bg-surface p-6">
            <h2 className="font-semibold">
              {copy('No permissions assigned', 'common')}
            </h2>
            <p className="mt-2 leading-6 text-muted">
              {copy(
                'Your session is active. Ask an administrator if you need access to additional capabilities.',
                'common',
              )}
            </p>
          </div>
        )}
      </div>
      <p className="mt-5 text-xs leading-6 text-muted">
        {copy(
          'Permissions are checked by the server for every protected operation. This page does not grant or change access.',
          'common',
        )}
      </p>
    </section>
  )
}
