import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useFieldArray, useForm } from 'react-hook-form'
import type { FieldPath } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { hasPermission } from '../auth/permissions'
import { emptyProfile, profileSchema } from './models'
import type { Client, Profile } from './models'
import { useClients } from './hooks'
import * as api from './service'

type Draft = Omit<Profile, 'tags'> & { tags_text: string }
const draftOf = (profile: Profile): Draft => ({
  name: profile.name,
  legal_name: profile.legal_name,
  website: profile.website,
  notes: profile.notes,
  contacts: profile.contacts.map((c) => ({ ...c })),
  tags_text: profile.tags.join('\n'),
})
export function ClientForm({ client }: { client?: Client }) {
  const operation = useClients()
  const navigate = useNavigate()
  const [revision, setRevision] = useState(client?.revision ?? 1)
  const [reloading, setReloading] = useState(false)
  const [reloadError, setReloadError] = useState('')
  const busy = operation.pending || reloading
  const {
    register,
    control,
    handleSubmit,
    reset,
    clearErrors,
    setError,
    formState: { errors },
  } = useForm<Draft>({ defaultValues: draftOf(client ?? emptyProfile) })
  const contacts = useFieldArray({ control, name: 'contacts' })
  async function submit(draft: Draft) {
    if (busy) return
    clearErrors()
    const parsed = profileSchema.safeParse({
      ...draft,
      tags: draft.tags_text
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = (
          issue.path[0] === 'tags' ? 'tags_text' : issue.path.join('.')
        ) as FieldPath<Draft>
        setError(field, { message: issue.message }, { shouldFocus: true })
      }
      return
    }
    const result = await operation.run(() =>
      client ? api.update(client.id, parsed.data, revision) : api.create(parsed.data),
    )
    if (!result) return
    if (
      hasPermission(operation.auth.session?.user.permissions ?? [], {
        permission: 'clients.view',
        scope: 'client',
        clientID: result.id,
      })
    )
      navigate(`/app/clients/${result.id}`, {
        replace: true,
        state: { clientSaved: client ? 'updated' : 'created' },
      })
    else
      navigate('/app/clients', {
        replace: true,
        state: { clientCreated: true },
      })
  }
  async function reload() {
    if (busy || !client) return
    setReloading(true)
    setReloadError('')
    try {
      const current = await operation.read(() => api.client(client.id))
      operation.cache.setQueryData([...operation.key, 'detail', client.id], current)
      setRevision(current.revision)
      reset(draftOf(current))
      operation.clearError()
    } catch {
      setReloadError('Unable to reload this client. Try again.')
    } finally {
      setReloading(false)
    }
  }
  return (
    <form
      className="grid max-w-3xl gap-5"
      noValidate
      aria-busy={busy}
      onSubmit={(e) => {
        void handleSubmit(submit)(e)
      }}
    >
      <fieldset disabled={busy} className="grid gap-4 rounded-md border border-line bg-surface p-5">
        <legend className="px-1 font-semibold">Client profile</legend>
        <TextField
          label="Client name"
          required
          maxLength={400}
          {...register('name')}
          error={errors.name?.message ?? ''}
        />
        <TextField
          label="Legal name"
          maxLength={400}
          {...register('legal_name')}
          error={errors.legal_name?.message ?? ''}
        />
        <TextField
          label="Website"
          type="url"
          maxLength={2048}
          {...register('website')}
          error={errors.website?.message ?? ''}
        />
        <div className="grid gap-1.5">
          <label htmlFor="client-notes" className="font-semibold">
            Internal notes
          </label>
          <p id="client-notes-help" className="text-xs text-muted">
            Up to 4,000 characters in one paragraph. Line breaks are not supported.
          </p>
          <textarea
            id="client-notes"
            className="ui-input min-h-24"
            maxLength={8000}
            {...register('notes')}
            aria-invalid={!!errors.notes}
            aria-describedby="client-notes-help client-notes-error"
          />
          {errors.notes ? (
            <p id="client-notes-error" role="alert" className="text-xs text-danger-ink">
              {errors.notes.message}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="client-tags" className="font-semibold">
            Tags
          </label>
          <p id="client-tags-help" className="text-xs text-muted">
            One tag per line. Up to 20 distinct tags, 40 characters each; saved in lowercase.
          </p>
          <textarea
            id="client-tags"
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('tags_text')}
            aria-invalid={!!errors.tags_text}
            aria-describedby="client-tags-help client-tags-error"
          />
          {errors.tags_text ? (
            <p id="client-tags-error" role="alert" className="text-xs text-danger-ink">
              {errors.tags_text.message}
            </p>
          ) : null}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 rounded-md border border-line bg-surface p-5">
        <legend className="px-1 font-semibold">Contacts</legend>
        <p className="text-xs text-muted">
          Up to 20 contacts. Changes replace this client’s complete contact list.
        </p>
        {contacts.fields.map((contact, index) => (
          <div key={contact.id} className="grid gap-3 border-b border-line pb-4 last:border-b-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Contact {index + 1}</h3>
              <Button
                size="compact"
                onClick={() => contacts.remove(index)}
                aria-label={`Remove contact ${index + 1}`}
              >
                Remove
              </Button>
            </div>
            <TextField
              label={`Contact ${index + 1} name`}
              required
              maxLength={200}
              {...register(`contacts.${index}.name`)}
              error={errors.contacts?.[index]?.name?.message ?? ''}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={`Contact ${index + 1} email`}
                type="email"
                maxLength={254}
                {...register(`contacts.${index}.email`)}
                error={errors.contacts?.[index]?.email?.message ?? ''}
              />
              <TextField
                label={`Contact ${index + 1} phone`}
                type="tel"
                maxLength={80}
                {...register(`contacts.${index}.phone`)}
                error={errors.contacts?.[index]?.phone?.message ?? ''}
              />
            </div>
          </div>
        ))}
        {errors.contacts?.message ? (
          <p role="alert" className="text-xs text-danger-ink">
            {errors.contacts.message}
          </p>
        ) : null}
        <div>
          <Button
            disabled={contacts.fields.length >= 20}
            onClick={() => contacts.append({ name: '', email: '', phone: '' })}
          >
            Add contact
          </Button>
        </div>
      </fieldset>
      {operation.error ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{operation.error}</p>
          {client ? (
            <>
              <p className="mt-3 text-xs text-muted">
                Reloading discards your draft. Review the current record before saving again.
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                Reload current data
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reloadError ? (
        <p role="alert" className="text-danger-ink">
          {reloadError}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {busy ? (
          <Button disabled>Cancel</Button>
        ) : (
          <Link
            className={buttonStyles()}
            to={client ? `/app/clients/${client.id}` : '/app/clients'}
          >
            Cancel
          </Link>
        )}
        <Button type="submit" variant="primary" loading={busy} loadingLabel="Saving client">
          {client ? 'Save client' : 'Create client'}
        </Button>
      </div>
    </form>
  )
}
