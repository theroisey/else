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
  const operation = useAdministration()
  const { auth } = operation
  const grants = auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, { permission: 'users.manage', scope: 'global' })
  const roleView = hasPermission(grants, { permission: 'roles.view', scope: 'global' })
  const cursor = useCursor()
  const query = useQuery({
    queryKey: ['administration', auth.session?.user.id, 'users', cursor.cursor],
    queryFn: ({ signal }) => operation.read(() => api.users(signal, cursor.cursor)),
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
        title="Users"
        description="Manage account profiles, access assignments and account status."
      >
        <div className="flex flex-wrap gap-2">
          <Button icon={faRotateRight} disabled={query.isFetching} onClick={refresh}>
            Refresh
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
              Create account
            </Button>
          ) : null}
        </div>
      </PageHeader>
      {!manage ? (
        <p className="mb-4 text-xs text-muted">View only · Account changes require users.manage.</p>
      ) : null}
      {notice ? (
        <p className="mb-4" role="status">
          {notice}
        </p>
      ) : null}
      {query.isPending ? (
        <PageSkeleton label="Loading users…" />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : query.data.data.length === 0 ? (
        <div className="empty-state">
          <h2 className="font-semibold">No users on this page</h2>
          <p className="mt-2 text-muted">Create an account or return to the previous page.</p>
        </div>
      ) : (
        <Table caption="User accounts">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((user) => (
              <tr key={user.id}>
                <td>
                  <p className="font-semibold">
                    {user.display_name}
                    {user.id === auth.session?.user.id ? (
                      <span className="ml-2 text-xs font-normal text-muted">You</span>
                    ) : null}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted">{user.email}</p>
                </td>
                <td>
                  <Status tone={user.status === 'active' ? 'success' : 'neutral'}>
                    {user.status === 'active' ? 'Active' : 'Disabled'}
                  </Status>
                </td>
                <td className="whitespace-nowrap text-xs text-muted">
                  {user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : 'Never'}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {manage ? (
                      <Button
                        size="compact"
                        aria-label={`Edit ${user.display_name}`}
                        onClick={() => setEditor(user)}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {roleView ? (
                      <Button
                        size="compact"
                        aria-label={`Roles for ${user.display_name}`}
                        onClick={() => setRoles(user)}
                      >
                        Roles
                      </Button>
                    ) : null}
                    {manage && user.status === 'active' && user.id !== auth.session?.user.id ? (
                      <Button
                        size="compact"
                        variant="danger-ghost"
                        aria-label={`Disable ${user.display_name}`}
                        onClick={() => {
                          operation.clearError()
                          setDisable(user)
                        }}
                      >
                        Disable
                      </Button>
                    ) : null}
                    {!manage && !roleView ? (
                      <span className="text-xs text-muted">View only</span>
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
                ? 'Account created. Assign roles to grant access.'
                : 'Account updated.',
            )
            refresh()
          }}
        />
      ) : null}
      {manage && disable && disable.id !== auth.session?.user.id ? (
        <Confirmation
          title={`Disable ${disable.display_name}?`}
          description="This revokes all active sessions and prevents sign-in. At least one active administrator must remain."
          pending={operation.pending}
          error={operation.error}
          label="Disable account"
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
      {roleView && roles ? <AssignmentsEditor user={roles} onClose={() => setRoles(null)} /> : null}
    </section>
  )
}
