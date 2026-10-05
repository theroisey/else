import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Dialog, Table, TextField } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { isUUID } from '../auth/session'
import { useAdministration, useCursor } from './hooks'
import { Confirmation, ErrorState, Pager } from './Shared'
import { canAssign } from './models'
import type { Assignment, User } from './models'
import * as api from './service'

export function AssignmentsEditor({ user, onClose }: { user: User; onClose: () => void }) {
  const operation = useAdministration()
  const grants = operation.auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, { permission: 'roles.manage', scope: 'global' })
  const cursor = useCursor()
  const roleCursor = useCursor()
  const [roleID, setRoleID] = useState('')
  const [scope, setScope] = useState<'global' | 'client'>('global')
  const [client, setClient] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [remove, setRemove] = useState<Assignment | null>(null)
  const [notice, setNotice] = useState('')
  const actor = operation.auth.session?.user.id
  const assignments = useQuery({
    queryKey: ['administration', actor, 'assignments', user.id, cursor.cursor],
    queryFn: ({ signal }) => operation.read(() => api.assignments(user.id, signal, cursor.cursor)),
  })
  const roles = useQuery({
    queryKey: ['administration', actor, 'roles', roleCursor.cursor],
    queryFn: ({ signal }) => operation.read(() => api.roles(signal, roleCursor.cursor)),
    enabled: manage && user.status === 'active',
  })
  const removalRole = useQuery({
    queryKey: ['administration', actor, 'role', remove?.role_id],
    queryFn: ({ signal }) => operation.read(() => api.role(remove!.role_id, signal)),
    enabled: !!remove && manage,
  })
  const role = roles.data?.data.find((r) => r.id === roleID)
  const canAdd =
    manage &&
    user.status === 'active' &&
    !roles.isError &&
    !!role &&
    canAssign(grants, role, scope, client.trim().toLowerCase())
  if (remove) {
    const allowed =
      manage &&
      !removalRole.isError &&
      !!removalRole.data &&
      canAssign(grants, removalRole.data, remove.scope, remove.client_id ?? '')
    return (
      <Confirmation
        title={`Remove ${remove.display_name}?`}
        description={`Revoke this ${remove.scope} assignment for ${user.display_name}. Existing sessions immediately lose the permissions it grants.`}
        pending={operation.pending}
        disabled={!allowed}
        error={
          operation.error ||
          (removalRole.isPending
            ? 'Checking current role permissions…'
            : allowed
              ? ''
              : 'You must control every effective permission at this assignment’s scope.')
        }
        label="Remove assignment"
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          if (allowed)
            void operation
              .run(() =>
                api.request(`/users/${user.id}/roles/${remove.id}`, {
                  method: 'DELETE',
                  body: { confirm: true },
                }),
              )
              .then((saved) => {
                if (saved) {
                  setRemove(null)
                  setNotice('Role assignment removed.')
                }
              })
        }}
      />
    )
  }
  if (confirm && role)
    return (
      <Confirmation
        title={`Assign ${role.display_name}?`}
        description={`Grant this role to ${user.display_name} ${scope === 'global' ? 'globally' : `for client ${client.trim().toLowerCase()}`}. Review the scope before confirming.`}
        pending={operation.pending}
        disabled={!canAdd}
        error={operation.error}
        label="Assign role"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          if (canAdd)
            void operation
              .run(() =>
                api.request(`/users/${user.id}/roles`, {
                  method: 'POST',
                  body: {
                    role_id: role.id,
                    scope,
                    ...(scope === 'client' ? { client_id: client.trim().toLowerCase() } : {}),
                    confirm: true,
                  },
                }),
              )
              .then((saved) => {
                if (saved) {
                  setConfirm(false)
                  setRoleID('')
                  setClient('')
                  setNotice('Role assigned.')
                }
              })
        }}
      />
    )
  return (
    <Dialog
      variant="drawer"
      eyebrow="Access assignments"
      open
      title={`Roles for ${user.display_name}`}
      description="Global assignments cover all clients. Client assignments grant only the role’s client permissions at the exact client scope."
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      <div className="mt-5 grid gap-4">
        {notice ? <p role="status">{notice}</p> : null}
        {assignments.isPending ? (
          <p role="status">Loading assignments…</p>
        ) : assignments.isError ? (
          <ErrorState
            error={assignments.error}
            retry={() => {
              void assignments.refetch()
            }}
          />
        ) : assignments.data.data.length === 0 ? (
          <p className="text-muted">No active role assignments on this page.</p>
        ) : (
          <Table caption="Active role assignments">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Scope</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {assignments.data.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.display_name}</td>
                  <td>
                    <span className="block capitalize">{a.scope}</span>
                    {a.client_id ? (
                      <span className="block break-all font-mono text-xs text-muted">
                        {a.client_id}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {manage ? (
                      <Button
                        size="compact"
                        variant="danger"
                        aria-label={`Remove ${a.display_name}`}
                        onClick={() => {
                          operation.clearError()
                          setRemove(a)
                        }}
                      >
                        Remove
                      </Button>
                    ) : (
                      <span className="text-xs text-muted">View only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          label="Assignment pagination"
          page={assignments.isError ? undefined : assignments.data}
          cursor={cursor}
          busy={assignments.isFetching}
        />
        {manage && user.status === 'active' ? (
          <fieldset className="grid gap-3 border-t border-line pt-4">
            <legend className="font-semibold">Assign a role</legend>
            {roles.isPending ? (
              <p role="status">Loading available roles…</p>
            ) : roles.isError ? (
              <ErrorState
                error={roles.error}
                retry={() => {
                  void roles.refetch()
                }}
              />
            ) : (
              <>
                <label className="grid gap-1.5 text-sm font-semibold">
                  Scope
                  <select
                    className="ui-input"
                    value={scope}
                    onChange={(e) => {
                      setScope(e.target.value as 'global' | 'client')
                      setRoleID('')
                    }}
                  >
                    <option value="global">Global</option>
                    <option value="client">Client</option>
                  </select>
                </label>
                {scope === 'client' ? (
                  <TextField
                    label="Client ID"
                    value={client}
                    onChange={(e) => {
                      setClient(e.target.value)
                      setRoleID('')
                    }}
                    description="Enter the exact client UUID for this scoped assignment."
                    error={
                      client && !isUUID(client.trim().toLowerCase()) ? 'Enter a nonzero UUID.' : ''
                    }
                  />
                ) : null}
                <label className="grid gap-1.5 text-sm font-semibold">
                  Role
                  <select
                    className="ui-input"
                    value={roleID}
                    onChange={(e) => setRoleID(e.target.value)}
                  >
                    <option value="">Select a role</option>
                    {roles.data.data.map((r) => (
                      <option
                        value={r.id}
                        key={r.id}
                        disabled={!canAssign(grants, r, scope, client.trim().toLowerCase())}
                      >
                        {r.display_name}
                        {!canAssign(grants, r, scope, client.trim().toLowerCase())
                          ? ' · Unavailable at this scope'
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <Pager
                  label="Available role pagination"
                  page={roles.data}
                  cursor={roleCursor}
                  busy={roles.isFetching}
                />
                <p className="text-xs text-muted">
                  Only roles whose effective permissions you control at this scope are available.
                </p>
                <Button
                  disabled={!canAdd}
                  variant="primary"
                  onClick={() => {
                    operation.clearError()
                    setConfirm(true)
                  }}
                >
                  Review assignment
                </Button>
              </>
            )}
          </fieldset>
        ) : (
          <p className="text-xs text-muted">
            {user.status === 'disabled'
              ? 'Disabled accounts cannot receive new assignments.'
              : 'Changes require roles.manage.'}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  )
}
