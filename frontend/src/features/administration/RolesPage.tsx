import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { faPlus, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import { Button, Status, Table } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { useAdministration, useCursor } from './hooks'
import { ErrorState, PageHeader, Pager } from './Shared'
import { RoleForm } from './RoleForm'
import { globallyControls } from './models'
import type { Role } from './models'
import * as api from './service'

export function RolesPage() {
  const operation = useAdministration()
  const cursor = useCursor()
  const grants = operation.auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, { permission: 'roles.manage', scope: 'global' })
  const query = useQuery({
    queryKey: ['administration', operation.auth.session?.user.id, 'roles', cursor.cursor],
    queryFn: ({ signal }) => operation.read(() => api.roles(signal, cursor.cursor)),
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
        title="Roles"
        description="Define reusable permission sets. Changes affect every holder of a role."
      >
        <div className="flex flex-wrap gap-2">
          <Button icon={faRotateRight} disabled={query.isFetching} onClick={refresh}>
            Refresh
          </Button>
          {manage ? (
            <Button variant="primary" icon={faPlus} onClick={() => setEditor('create')}>
              Create role
            </Button>
          ) : null}
        </div>
      </PageHeader>
      {!manage ? (
        <p className="mb-4 text-xs text-muted">View only · Role changes require roles.manage.</p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4">
          {notice}
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status" aria-busy="true">
          Loading roles…
        </p>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          retry={() => {
            void query.refetch()
          }}
        />
      ) : query.data.data.length === 0 ? (
        <div className="rounded-md border border-line bg-surface p-6">
          <h2 className="font-semibold">No roles on this page</h2>
          <p className="mt-2 text-muted">Create a custom role or return to the previous page.</p>
        </div>
      ) : (
        <Table caption="Roles and permissions">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Definition</th>
              <th scope="col">Permissions</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data.data.map((role) => (
              <tr key={role.id}>
                <td className="font-semibold">{role.display_name}</td>
                <td>
                  <Status>{role.system_role ? 'Built-in' : 'Custom'}</Status>
                </td>
                <td>
                  <span className="font-mono text-xs">{role.permissions.length}</span>
                </td>
                <td>
                  <Button
                    size="compact"
                    aria-label={`${manage && !role.system_role && role.permissions.every((key) => globallyControls(grants, key)) ? 'Edit permissions' : 'View permissions'} for ${role.display_name}`}
                    onClick={() => setEditor(role)}
                  >
                    {manage &&
                    !role.system_role &&
                    role.permissions.every((key) => globallyControls(grants, key))
                      ? 'Edit permissions'
                      : 'View permissions'}
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
            setNotice(editor === 'create' ? 'Role created.' : 'Role permissions updated.')
            refresh()
          }}
        />
      ) : null}
    </section>
  )
}
