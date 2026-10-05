import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Button, Dialog, TextField } from '../../components/ui'
import { useAdministration, useCatalog } from './hooks'
import { Confirmation, ErrorState, PermissionChoices } from './Shared'
import { globallyControls } from './models'
import type { Role } from './models'
import { request } from './service'

export function RoleForm({
  role,
  editable,
  onClose,
  onSaved,
}: {
  role?: Role | undefined
  editable: boolean
  onClose: () => void
  onSaved: () => void
}) {
  useLocale()
  const operation = useAdministration()
  const catalog = useCatalog()
  const [name, setName] = useState(role?.display_name ?? '')
  const [selected, setSelected] = useState(role?.permissions ?? [])
  const [validation, setValidation] = useState('')
  const [confirm, setConfirm] = useState(false)
  const grants = operation.auth.session?.user.permissions ?? []
  const allowed = (key: string) => globallyControls(grants, key)
  async function save() {
    const saved = await operation.run(() =>
      role
        ? request(`/roles/${role.id}/permissions`, {
            method: 'PUT',
            body: {
              permissions: selected,
              expected_revision: role.revision,
              confirm: true,
            },
          })
        : request('/roles', {
            method: 'POST',
            body: { display_name: name.trim(), permissions: selected },
          }),
    )
    if (saved) onSaved()
  }
  if (confirm && role)
    return (
      <Confirmation
        title={copy('Change permissions for {{value1}}?', 'administration', {
          value1: role.display_name,
        })}
        description={copy(
          'This replaces the role’s permissions for all current and future holders. At least one active administrator must remain. Close this editor and refresh to recover from a revision conflict.',
          'administration',
        )}
        pending={operation.pending}
        disabled={!editable || selected.some((key) => !allowed(key))}
        error={copy(operation.error, 'administration')}
        label={copy('Replace permissions', 'administration')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          if (editable && selected.every(allowed)) void save()
        }}
      />
    )
  return (
    <Dialog
      variant="drawer"
      eyebrow={copy('Role definition', 'administration')}
      open
      title={
        role
          ? editable
            ? copy('Edit permissions', 'administration')
            : copy('Role permissions', 'administration')
          : copy('Create role', 'administration')
      }
      description={
        role
          ? role.display_name
          : copy(
              'Create a custom role from permissions you control globally.',
              'administration',
            )
      }
      onClose={() => {
        if (!operation.pending) onClose()
      }}
    >
      {catalog.isPending ? (
        <p className="mt-4" role="status">
          {copy('Loading permissions…', 'administration')}
        </p>
      ) : catalog.isError ? (
        <ErrorState
          error={catalog.error}
          retry={() => {
            void catalog.refetch()
          }}
        />
      ) : (
        <form
          className="mt-5 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setValidation('')
            if (!editable) return
            if (
              !name.trim() ||
              [...name.trim()].length > 100 ||
              /[\p{Cc}]/u.test(name) ||
              selected.length < 1 ||
              selected.some((key) => !allowed(key))
            ) {
              setValidation(
                'Use a name of 1–100 characters and select at least one permission you control globally.',
              )
              return
            }
            if (role) setConfirm(true)
            else void save()
          }}
          noValidate
        >
          {!role ? (
            <TextField
              label={copy('Role name', 'administration')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={operation.pending}
            />
          ) : null}
          {!editable ? (
            <p className="text-xs text-muted">
              {role?.system_role
                ? copy('Built-in definitions are read only.', 'administration')
                : copy(
                    'Editing requires global roles.manage and control of all existing permissions.',
                    'administration',
                  )}
            </p>
          ) : null}
          <PermissionChoices
            catalog={catalog.data}
            selected={selected}
            onChange={setSelected}
            allowed={allowed}
            disabled={operation.pending || !editable}
          />
          {validation ? (
            <p role="alert" className="text-danger-ink">
              {copy(validation, 'administration')}
            </p>
          ) : null}
          {copy(operation.error, 'administration') ? (
            <p role="alert" className="text-danger-ink">
              {copy(operation.error, 'administration')}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={operation.pending} onClick={onClose}>
              {editable
                ? copy('Cancel', 'administration')
                : copy('Close', 'administration')}
            </Button>
            {editable ? (
              <Button
                type="submit"
                variant="primary"
                loading={operation.pending}
                loadingLabel={copy('Saving role', 'administration')}
              >
                {role
                  ? copy('Review changes', 'administration')
                  : copy('Create role', 'administration')}
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </Dialog>
  )
}
