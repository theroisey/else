import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { faPlus, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, Table, PageSkeleton } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { useAdministration, useCursor } from './hooks'
import { ErrorState, PageHeader, Pager } from './Shared'
import { RoleForm } from './RoleForm'
import { globallyControls } from './models'
import type { Role } from './models'
import * as api from './service'

export function RolesPage() {
  useLocale()
  const operation = useAdministration()
  const cursor = useCursor()
  const grants = operation.auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, {
    permission: 'roles.manage',
    scope: 'global',
  })
  const query = useQuery({
    queryKey: [
      'administration',
      operation.auth.session?.user.id,
      'roles',
      cursor.cursor,
    ],
    queryFn: ({ signal }) =>
      operation.read(() => api.roles(signal, cursor.cursor)),
  })
  const [editor, setEditor] = useState<Role | 'create' | null>(null)
  const [notice, setNotice] = useState('')
  function refresh() {
    cursor.reset()
    void operation.client.invalidateQueries({
      queryKey: ['administration', operation.auth.session?.user.id, 'roles'],
    })
  }
  const editable =
    manage &&
    (editor === 'create' ||
      (!!editor &&
        !editor.system_role &&
        editor.permissions.every((key) => globallyControls(grants, key))))
  return (
    <section>
      <PageHeader
        title={copy('Roles', 'administration')}
        description={copy(
          'Define reusable permission sets. Changes affect every holder of a role.',
          'administration',
        )}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            icon={faRotateRight}
            disabled={query.isFetching}
            onClick={refresh}
          >
            {copy('Refresh', 'administration')}
          </Button>
          {manage ? (
            <Button
              variant="primary"
              icon={faPlus}
              onClick={() => setEditor('create')}
            >
              {copy('Create role', 'administration')}
            </Button>
          ) : null}
        </div>
      </PageHeader>
      {!manage ? (
        <p className="mb-4 text-xs text-muted">
          {copy(
            'View only · Role changes require roles.manage.',
            'administration',
          )}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4">
          {copy(notice, 'administration')}
        </p>
      ) : null}
      {query.isPending ? (
        <PageSkeleton label={copy('Loading roles…', 'administration')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : query.data.data.length === 0 ? (
        <div className="empty-state">
          <h2 className="font-semibold">
            {copy('No roles on this page', 'administration')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Create a custom role or return to the previous page.',
              'administration',
            )}
          </p>
        </div>
      ) : (
        <Table caption={copy('Roles and permissions', 'administration')}>
          <thead>
            <tr>
              <th scope="col">{copy('Role', 'administration')}</th>
              <th scope="col">{copy('Definition', 'administration')}</th>
              <th scope="col">{copy('Permissions', 'administration')}</th>
              <th scope="col">{copy('Actions', 'administration')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((role) => (
              <tr key={role.id}>
                <td className="font-semibold">{role.display_name}</td>
                <td>
                  <Status>
                    {role.system_role
                      ? copy('Built-in', 'administration')
                      : copy('Custom', 'administration')}
                  </Status>
                </td>
                <td>
                  <span className="font-mono text-xs">
                    {role.permissions.length}
                  </span>
                </td>
                <td>
                  <Button
                    size="compact"
                    aria-label={copy(
                      '{{value1}} for {{value2}}',
                      'administration',
                      {
                        value1:
                          manage &&
                          !role.system_role &&
                          role.permissions.every((key) =>
                            globallyControls(grants, key),
                          )
                            ? copy('Edit permissions', 'administration')
                            : copy('View permissions', 'administration'),
                        value2: role.display_name,
                      },
                    )}
                    onClick={() => setEditor(role)}
                  >
                    {manage &&
                    !role.system_role &&
                    role.permissions.every((key) =>
                      globallyControls(grants, key),
                    )
                      ? copy('Edit permissions', 'administration')
                      : copy('View permissions', 'administration')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pager
        page={query.isError ? undefined : query.data}
        cursor={cursor}
        busy={query.isFetching}
      />
      {editor && (editor !== 'create' || manage) ? (
        <RoleForm
          role={editor === 'create' ? undefined : editor}
          editable={editable}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            setNotice(
              editor === 'create'
                ? copy('Role created.', 'administration')
                : copy('Role permissions updated.', 'administration'),
            )
            refresh()
          }}
        />
      ) : null}
    </section>
  )
}
