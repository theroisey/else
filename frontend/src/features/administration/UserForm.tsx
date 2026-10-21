import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Dialog, TextField } from '../../components/ui'
import { useAdministration } from './hooks'
import { parseUser, profileErrors } from './models'
import { isRecord } from '../auth/session'
import type { User } from './models'
import { request } from './service'

export function UserForm({
  user,
  onClose,
  onSaved,
}: {
  user?: User | undefined
  onClose: () => void
  onSaved: () => void
}) {
  useLocale()
  const { run, read, pending, error, clearError } = useAdministration()
  const [email, setEmail] = useState(user?.email ?? '')
  const [name, setName] = useState(user?.display_name ?? '')
  const [revision, setRevision] = useState(user?.revision ?? 1)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reloadError, setReloadError] = useState('')
  const [reloading, setReloading] = useState(false)
  const busy = pending || reloading
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const invalid = profileErrors(email, name)
    setErrors(invalid)
    if (Object.keys(invalid).length) return
    const saved = await run(() =>
      user
        ? request(`/users/${user.id}`, {
            method: 'PATCH',
            body: {
              email: email.trim().toLowerCase(),
              display_name: name.trim(),
              expected_revision: revision,
            },
          })
        : request('/users', {
            method: 'POST',
            body: {
              email: email.trim().toLowerCase(),
              display_name: name.trim(),
            },
          }),
    )
    if (saved) onSaved()
  }
  async function reload() {
    if (busy || !user) return
    setReloading(true)
    setReloadError('')
    try {
      const body = await read(() => request(`/users/${user.id}`))
      if (!isRecord(body)) throw new Error('Invalid account response')
      const current = parseUser(body.data)
      setEmail(current.email)
      setName(current.display_name)
      setRevision(current.revision)
      setErrors({})
      clearError()
    } catch {
      setReloadError('Unable to reload this account. Try again.')
    } finally {
      setReloading(false)
    }
  }
  return (
    <Dialog
      variant="drawer"
      eyebrow={copy('Account details', 'administration')}
      open
      title={
        user
          ? copy('Edit account', 'administration')
          : copy('Create account', 'administration')
      }
      description={
        user
          ? copy(
              'Update this account’s profile. Its access and status are managed separately.',
              'administration',
            )
          : copy(
              'New accounts start without roles and sign in with an email verification code.',
              'administration',
            )
      }
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="field-grid mt-5 grid gap-4"
        onSubmit={(event) => {
          void submit(event)
        }}
        noValidate
        aria-busy={busy}
      >
        <TextField
          label={copy('Display name', 'administration')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          error={copy(errors.name, 'administration') ?? ''}
          disabled={busy}
        />
        <TextField
          label={copy('Email', 'administration')}
          type="email"
          readOnly={Boolean(user)}
          description={
            user
              ? copy(
                  'Registered email changes require verified operator recovery.',
                  'administration',
                )
              : ''
          }
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={254}
          error={copy(errors.email, 'administration') ?? ''}
          disabled={busy}
        />
        {error ? (
          <p className="text-danger-ink" role="alert">
            {copy(error, 'administration')}
          </p>
        ) : null}
        {reloadError ? (
          <p className="text-danger-ink" role="alert">
            {copy(reloadError, 'administration')}
          </p>
        ) : null}
        {user && error ? (
          <div>
            <p className="mb-2 text-xs text-muted">
              {copy(
                'Reloading discards this draft and uses the account’s current profile.',
                'administration',
              )}
            </p>
            <Button
              disabled={busy}
              onClick={() => {
                void reload()
              }}
            >
              {copy('Reload current data', 'administration')}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            {copy('Cancel', 'administration')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            loadingLabel={copy('Saving account', 'administration')}
          >
            {user
              ? copy('Save account', 'administration')
              : copy('Create account', 'administration')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
