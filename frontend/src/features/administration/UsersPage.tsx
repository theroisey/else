import { currentLocale } from '../../i18n'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { faPlus, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, Table, PageSkeleton } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { useAdministration, useCursor } from './hooks'
import { Confirmation, ErrorState, PageHeader, Pager } from './Shared'
import { UserForm } from './UserForm'
import { AssignmentsEditor } from './AssignmentsEditor'
import type { User } from './models'
import * as api from './service'

export function UsersPage() {
  useLocale()
  const operation = useAdministration()
  const { auth } = operation
  const grants = auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, {
    permission: 'users.manage',
    scope: 'global',
  })
  const roleView = hasPermission(grants, {
    permission: 'roles.view',
    scope: 'global',
  })
  const cursor = useCursor()
  const query = useQuery({
    queryKey: ['administration', auth.session?.user.id, 'users', cursor.cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.users(signal, cursor.cursor)),
  })
  const [editor, setEditor] = useState<User | 'create' | null>(null)
  const [disable, setDisable] = useState<User | null>(null)
  const [roles, setRoles] = useState<User | null>(null)
  const [notice, setNotice] = useState('')
  function refresh() {
    cursor.reset()
    void operation.client.invalidateQueries({
      queryKey: ['administration', auth.session?.user.id, 'users'],
    })
  }
  return (
    <section>
      <PageHeader
        title={copy('Users', 'administration')}
        description={copy(
          'Manage account profiles, access assignments and account status.',
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
              onClick={() => {
                setNotice('')
                setEditor('create')
              }}
            >
              {copy('Create account', 'administration')}
            </Button>
          ) : null}
        </div>
      </PageHeader>
      {!manage ? (
        <p className="mb-4 text-xs text-muted">
          {copy(
            'View only · Account changes require users.manage.',
            'administration',
          )}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4" role="status">
          {copy(notice, 'administration')}
        </p>
      ) : null}
      {query.isPending ? (
        <PageSkeleton label={copy('Loading users…', 'administration')} />
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
            {copy('No users on this page', 'administration')}
          </h2>
          <p className="mt-2 text-muted">
            {copy(
              'Create an account or return to the previous page.',
              'administration',
            )}
          </p>
        </div>
      ) : (
        <Table caption={copy('User accounts', 'administration')}>
          <thead>
            <tr>
              <th scope="col">{copy('Account', 'administration')}</th>
              <th scope="col">{copy('Status', 'administration')}</th>
              <th scope="col">{copy('Last sign-in', 'administration')}</th>
              <th scope="col">{copy('Actions', 'administration')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((user) => (
              <tr key={user.id}>
                <td>
                  <p className="font-semibold">
                    {user.display_name}
                    {user.id === auth.session?.user.id ? (
                      <span className="ml-2 text-xs font-normal text-muted">
                        {copy('You', 'administration')}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted">
                    {user.email}
                  </p>
                </td>
                <td>
                  <Status
                    tone={user.status === 'active' ? 'success' : 'neutral'}
                  >
                    {user.status === 'active'
                      ? copy('Active', 'administration')
                      : copy('Disabled', 'administration')}
                  </Status>
                </td>
                <td className="whitespace-nowrap text-xs text-muted">
                  {user.last_login_at
                    ? new Date(user.last_login_at).toLocaleDateString(
                        currentLocale(),
                      )
                    : copy('Never', 'administration')}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {manage ? (
                      <Button
                        size="compact"
                        aria-label={copy('Edit {{value1}}', 'administration', {
                          value1: user.display_name,
                        })}
                        onClick={() => setEditor(user)}
                      >
                        {copy('Edit', 'administration')}
                      </Button>
                    ) : null}
                    {roleView ? (
                      <Button
                        size="compact"
                        aria-label={copy(
                          'Roles for {{value1}}',
                          'administration',
                          { value1: user.display_name },
                        )}
                        onClick={() => setRoles(user)}
                      >
                        {copy('Roles', 'administration')}
                      </Button>
                    ) : null}
                    {manage &&
                    user.status === 'active' &&
                    user.id !== auth.session?.user.id ? (
                      <Button
                        size="compact"
                        variant="danger-ghost"
                        aria-label={copy(
                          'Disable {{value1}}',
                          'administration',
                          { value1: user.display_name },
                        )}
                        onClick={() => {
                          operation.clearError()
                          setDisable(user)
                        }}
                      >
                        {copy('Disable', 'administration')}
                      </Button>
                    ) : null}
                    {!manage && !roleView ? (
                      <span className="text-xs text-muted">
                        {copy('View only', 'administration')}
                      </span>
                    ) : null}
                  </div>
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
      {manage && editor ? (
        <UserForm
          user={editor === 'create' ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null)
            setNotice(
              editor === 'create'
                ? copy(
                    'Account created. Assign roles to grant access.',
                    'administration',
                  )
                : copy('Account updated.', 'administration'),
            )
            refresh()
          }}
        />
      ) : null}
      {manage && disable && disable.id !== auth.session?.user.id ? (
        <Confirmation
          title={copy('Disable {{value1}}?', 'administration', {
            value1: disable.display_name,
          })}
          description={copy(
            'This revokes all active sessions and prevents sign-in. At least one active administrator must remain.',
            'administration',
          )}
          pending={operation.pending}
          error={copy(operation.error, 'administration')}
          label={copy('Disable account', 'administration')}
          onCancel={() => setDisable(null)}
          onConfirm={() => {
            void operation
              .run(() =>
                api.request(`/users/${disable.id}/disable`, {
                  method: 'POST',
                  body: { confirm: true, expected_revision: disable.revision },
                }),
              )
              .then((saved) => {
                if (saved) {
                  setDisable(null)
                  setNotice('Account disabled.')
                  refresh()
                }
              })
          }}
        />
      ) : null}
      {roleView && roles ? (
        <AssignmentsEditor user={roles} onClose={() => setRoles(null)} />
      ) : null}
    </section>
  )
}
