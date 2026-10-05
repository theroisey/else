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
      eyebrow="Account details"
      open
      title={user ? 'Edit account' : 'Create account'}
      description={
        user
          ? 'Update this account’s profile. Its access and status are managed separately.'
          : 'New accounts start without roles. Passwords are cleared after submission.'
      }
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className="mt-5 grid gap-4"
        onSubmit={(event) => {
          void submit(event)
        }}
        noValidate
        aria-busy={busy}
      >
        <TextField
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          error={errors.name ?? ''}
          disabled={busy}
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={254}
          error={errors.email ?? ''}
          disabled={busy}
        />
        {!user ? (
          <TextField
            ref={password}
            label="Initial password"
            type="password"
            autoComplete="new-password"
            required
            description="12–128 bytes. Share through your approved secure channel."
            error={errors.password ?? ''}
            disabled={busy}
          />
        ) : null}
        {error ? (
          <p className="text-danger-ink" role="alert">
            {error}
          </p>
        ) : null}
        {reloadError ? (
          <p className="text-danger-ink" role="alert">
            {reloadError}
          </p>
        ) : null}
        {user && error ? (
          <div>
            <p className="mb-2 text-xs text-muted">
              Reloading discards this draft and uses the account’s current profile.
            </p>
            <Button
              disabled={busy}
              onClick={() => {
                void reload()
              }}
            >
              Reload current data
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving account">
            {user ? 'Save account' : 'Create account'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
