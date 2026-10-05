import { SelectField } from '../../components/ui'
import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
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

export function AssignmentsEditor({
  user,
  onClose,
}: {
  user: User
  onClose: () => void
}) {
  useLocale()
  const operation = useAdministration()
  const grants = operation.auth.session?.user.permissions ?? []
  const manage = hasPermission(grants, {
    permission: 'roles.manage',
    scope: 'global',
  })
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
    queryFn: ({ signal }) =>
      operation.read(() => api.assignments(user.id, signal, cursor.cursor)),
  })
  const roles = useQuery({
    queryKey: ['administration', actor, 'roles', roleCursor.cursor],
    queryFn: ({ signal }) =>
      operation.read(() => api.roles(signal, roleCursor.cursor)),
    enabled: manage && user.status === 'active',
  })
  const removalRole = useQuery({
    queryKey: ['administration', actor, 'role', remove?.role_id],
    queryFn: ({ signal }) =>
      operation.read(() => api.role(remove!.role_id, signal)),
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
        title={copy('Remove {{value1}}?', 'administration', {
          value1: remove.display_name,
        })}
        description={copy(
          'Revoke this {{value1}} assignment for {{value2}}. Existing sessions immediately lose the permissions it grants.',
          'administration',
          { value1: remove.scope, value2: user.display_name },
        )}
        pending={operation.pending}
        disabled={!allowed}
        error={
          copy(operation.error, 'administration') ||
          (removalRole.isPending
            ? copy('Checking current role permissions…', 'administration')
            : allowed
              ? ''
              : copy(
                  'You must control every effective permission at this assignment’s scope.',
                  'administration',
                ))
        }
        label={copy('Remove assignment', 'administration')}
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
        title={copy('Assign {{value1}}?', 'administration', {
          value1: role.display_name,
        })}
        description={copy(
          'Grant this role to {{value1}} {{value2}}. Review the scope before confirming.',
          'administration',
          {
            value1: user.display_name,
            value2:
              scope === 'global'
                ? copy('globally', 'administration')
                : copy('for client {{client}}', 'administration', {
                    client: client.trim().toLowerCase(),
                  }),
          },
        )}
        pending={operation.pending}
        disabled={!canAdd}
        error={copy(operation.error, 'administration')}
        label={copy('Assign role', 'administration')}
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
                    ...(scope === 'client'
                      ? { client_id: client.trim().toLowerCase() }
                      : {}),
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
      eyebrow={copy('Access assignments', 'administration')}
      open
      title={copy('Roles for {{value1}}', 'administration', {
        value1: user.display_name,
      })}
      description={copy(
        'Global assignments cover all clients. Client assignments grant only the role’s client permissions at the exact client scope.',
        'administration',
      )}
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      <div className="mt-5 grid gap-4">
        {notice ? <p role="status">{copy(notice, 'administration')}</p> : null}
        {assignments.isPending ? (
          <p role="status">{copy('Loading assignments…', 'administration')}</p>
        ) : assignments.isError ? (
          <ErrorState
            error={assignments.error}
            retry={() => {
              void assignments.refetch()
            }}
          />
        ) : assignments.data.data.length === 0 ? (
          <p className="text-muted">
            {copy('No active role assignments on this page.', 'administration')}
          </p>
        ) : (
          <Table caption={copy('Active role assignments', 'administration')}>
            <thead>
              <tr>
                <th scope="col">{copy('Role', 'administration')}</th>
                <th scope="col">{copy('Scope', 'administration')}</th>
                <th scope="col">{copy('Action', 'administration')}</th>
              </tr>
            </thead>
            <tbody>
              {assignments.data.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.display_name}</td>
                  <td>
                    <span className="block capitalize">
                      {statusLabel(a.scope)}
                    </span>
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
                        aria-label={copy(
                          'Remove {{value1}}',
                          'administration',
                          { value1: a.display_name },
                        )}
                        onClick={() => {
                          operation.clearError()
                          setRemove(a)
                        }}
                      >
                        {copy('Remove', 'administration')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted">
                        {copy('View only', 'administration')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pager
          label={copy('Assignment pagination', 'administration')}
          page={assignments.isError ? undefined : assignments.data}
          cursor={cursor}
          busy={assignments.isFetching}
        />
        {manage && user.status === 'active' ? (
          <fieldset className="grid gap-3 border-t border-line pt-4">
            <legend className="font-semibold">
              {copy('Assign a role', 'administration')}
            </legend>
            {roles.isPending ? (
              <p role="status">
                {copy('Loading available roles…', 'administration')}
              </p>
            ) : roles.isError ? (
              <ErrorState
                error={roles.error}
                retry={() => {
                  void roles.refetch()
                }}
              />
            ) : (
              <>
                <SelectField
                  label={copy('Scope', 'administration')}
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as 'global' | 'client')
                    setRoleID('')
                  }}
                >
                  <option value="global">
                    {copy('Global', 'administration')}
                  </option>
                  <option value="client">
                    {copy('Client', 'administration')}
                  </option>
                </SelectField>
                {scope === 'client' ? (
                  <TextField
                    label={copy('Client ID', 'administration')}
                    value={client}
                    onChange={(e) => {
                      setClient(e.target.value)
                      setRoleID('')
                    }}
                    description={copy(
                      'Enter the exact client UUID for this scoped assignment.',
                      'administration',
                    )}
                    error={
                      client && !isUUID(client.trim().toLowerCase())
                        ? copy('Enter a nonzero UUID.', 'administration')
                        : ''
                    }
                  />
                ) : null}
                <SelectField
                  label={copy('Role', 'administration')}
                  value={roleID}
                  onChange={(e) => setRoleID(e.target.value)}
                >
                  <option value="">
                    {copy('Select a role', 'administration')}
                  </option>
                  {roles.data.data.map((r) => (
                    <option
                      value={r.id}
                      key={r.id}
                      disabled={
                        !canAssign(
                          grants,
                          r,
                          scope,
                          client.trim().toLowerCase(),
                        )
                      }
                    >
                      {r.display_name}
                      {!canAssign(grants, r, scope, client.trim().toLowerCase())
                        ? copy(' · Unavailable at this scope', 'administration')
                        : ''}
                    </option>
                  ))}
                </SelectField>
                <Pager
                  label={copy('Available role pagination', 'administration')}
                  page={roles.data}
                  cursor={roleCursor}
                  busy={roles.isFetching}
                />
                <p className="text-xs text-muted">
                  {copy(
                    'Only roles whose effective permissions you control at this scope are available.',
                    'administration',
                  )}
                </p>
                <Button
                  disabled={!canAdd}
                  variant="primary"
                  onClick={() => {
                    operation.clearError()
                    setConfirm(true)
                  }}
                >
                  {copy('Review assignment', 'administration')}
                </Button>
              </>
            )}
          </fieldset>
        ) : (
          <p className="text-xs text-muted">
            {user.status === 'disabled'
              ? copy(
                  'Disabled accounts cannot receive new assignments.',
                  'administration',
                )
              : copy('Changes require roles.manage.', 'administration')}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>{copy('Close', 'administration')}</Button>
        </div>
      </div>
    </Dialog>
  )
}
