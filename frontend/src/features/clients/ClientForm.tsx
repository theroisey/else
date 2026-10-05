import { copy, useLocale } from '../../i18n/index'
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
  useLocale()
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
      client
        ? api.update(client.id, parsed.data, revision)
        : api.create(parsed.data),
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
      operation.cache.setQueryData(
        [...operation.key, 'detail', client.id],
        current,
      )
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
      <fieldset disabled={busy} className="grid gap-4 form-section">
        <legend className="px-1 font-semibold">
          {copy('Client profile', 'clients')}
        </legend>
        <TextField
          label={copy('Client name', 'clients')}
          required
          maxLength={400}
          {...register('name')}
          error={copy(errors.name?.message, 'clients') ?? ''}
        />
        <TextField
          label={copy('Legal name', 'clients')}
          maxLength={400}
          {...register('legal_name')}
          error={copy(errors.legal_name?.message, 'clients') ?? ''}
        />
        <TextField
          label={
            client
              ? copy('Legacy profile website', 'clients')
              : copy('Initial website', 'clients')
          }
          description={copy(
            'Manage independent properties in the Websites area. This legacy field is retained for compatibility.',
            'clients',
          )}
          type="url"
          maxLength={2048}
          {...register('website')}
          error={copy(errors.website?.message, 'clients') ?? ''}
        />
        <div className="grid gap-1.5">
          <label htmlFor="client-notes" className="font-semibold">
            {copy('Internal notes', 'clients')}
          </label>
          <p id="client-notes-help" className="text-xs text-muted">
            {copy(
              'Up to 4,000 characters in one paragraph. Line breaks are not supported.',
              'clients',
            )}
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
            <p
              id="client-notes-error"
              role="alert"
              className="text-xs text-danger-ink"
            >
              {copy(errors.notes.message, 'clients')}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="client-tags" className="font-semibold">
            {copy('Tags', 'clients')}
          </label>
          <p id="client-tags-help" className="text-xs text-muted">
            {copy(
              'One tag per line. Up to 20 distinct tags, 40 characters each; saved in lowercase.',
              'clients',
            )}
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
            <p
              id="client-tags-error"
              role="alert"
              className="text-xs text-danger-ink"
            >
              {copy(errors.tags_text.message, 'clients')}
            </p>
          ) : null}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 form-section">
        <legend className="px-1 font-semibold">
          {copy('Contacts', 'clients')}
        </legend>
        <p className="text-xs text-muted">
          {copy(
            'Up to 20 contacts. Changes replace this client’s complete contact list.',
            'clients',
          )}
        </p>
        {contacts.fields.map((contact, index) => (
          <div
            key={contact.id}
            className="grid gap-3 border-b border-line pb-4 last:border-b-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">
                {copy('Contact {{value1}}', 'clients', { value1: index + 1 })}
              </h3>
              <Button
                size="compact"
                onClick={() => contacts.remove(index)}
                aria-label={copy('Remove contact {{value1}}', 'clients', {
                  value1: index + 1,
                })}
              >
                {copy('Remove', 'clients')}
              </Button>
            </div>
            <TextField
              label={copy('Contact {{value1}} name', 'clients', {
                value1: index + 1,
              })}
              required
              maxLength={200}
              {...register(`contacts.${index}.name`)}
              error={
                copy(errors.contacts?.[index]?.name?.message, 'clients') ?? ''
              }
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={copy('Contact {{value1}} email', 'clients', {
                  value1: index + 1,
                })}
                type="email"
                maxLength={254}
                {...register(`contacts.${index}.email`)}
                error={
                  copy(errors.contacts?.[index]?.email?.message, 'clients') ??
                  ''
                }
              />
              <TextField
                label={copy('Contact {{value1}} phone', 'clients', {
                  value1: index + 1,
                })}
                type="tel"
                maxLength={80}
                {...register(`contacts.${index}.phone`)}
                error={
                  copy(errors.contacts?.[index]?.phone?.message, 'clients') ??
                  ''
                }
              />
            </div>
          </div>
        ))}
        {copy(errors.contacts?.message, 'clients') ? (
          <p role="alert" className="text-xs text-danger-ink">
            {copy(errors.contacts?.message, 'clients')}
          </p>
        ) : null}
        <div>
          <Button
            disabled={contacts.fields.length >= 20}
            onClick={() => contacts.append({ name: '', email: '', phone: '' })}
          >
            {copy('Add contact', 'clients')}
          </Button>
        </div>
      </fieldset>
      {copy(operation.error, 'clients') ? (
        <div className="rounded-md border border-danger-line bg-danger-surface p-4">
          <p role="alert">{copy(operation.error, 'clients')}</p>
          {client ? (
            <>
              <p className="mt-3 text-xs text-muted">
                {copy(
                  'Reloading discards your draft. Review the current record before saving again.',
                  'clients',
                )}
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void reload()
                }}
              >
                {copy('Reload current data', 'clients')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {reloadError ? (
        <p role="alert" className="text-danger-ink">
          {copy(reloadError, 'clients')}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {busy ? (
          <Button disabled>{copy('Cancel', 'clients')}</Button>
        ) : (
          <Link
            className={buttonStyles()}
            to={client ? `/app/clients/${client.id}` : '/app/clients'}
          >
            {copy('Cancel', 'clients')}
          </Link>
        )}
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel={copy('Saving client', 'clients')}
        >
          {client
            ? copy('Save client', 'clients')
            : copy('Create client', 'clients')}
        </Button>
      </div>
    </form>
  )
}
