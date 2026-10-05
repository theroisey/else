import { copy, useLocale } from '../../i18n/index'
import { useRef, useState } from 'react'
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
  const password = useRef<HTMLInputElement>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const secret = user ? undefined : (password.current?.value ?? '')
    const invalid = profileErrors(email, name, secret)
    setErrors(invalid)
    if (Object.keys(invalid).length) return
    if (password.current) password.current.value = ''
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
              password: secret,
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
              'New accounts start without roles. Passwords are cleared after submission.',
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={254}
          error={copy(errors.email, 'administration') ?? ''}
          disabled={busy}
        />
        {!user ? (
          <TextField
            ref={password}
            label={copy('Initial password', 'administration')}
            type="password"
            autoComplete="new-password"
            required
            description={copy(
              '12–128 bytes. Share through your approved secure channel.',
              'administration',
            )}
            error={copy(errors.password, 'administration') ?? ''}
            disabled={busy}
          />
        ) : null}
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
