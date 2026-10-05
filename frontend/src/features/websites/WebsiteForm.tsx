import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Button, TextField } from '../../components/ui'
import * as api from './service'
import type { Website, WebsiteDraft } from './service'
import { useClients } from '../clients/hooks'

export function WebsiteForm({
  clientID,
  record,
  onSaved,
  onCancel,
}: {
  clientID: string
  record?: Website
  onSaved: (id: string) => void
  onCancel: () => void
}) {
  useLocale()
  const operation = useClients()
  const [draft, setDraft] = useState<WebsiteDraft>(
    record
      ? { name: record.name, url: record.url, description: record.description }
      : api.emptyWebsite,
  )
  return (
    <form
      className="field-grid mt-6 grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (operation.pending) return
        void operation
          .run(() => api.save(clientID, draft, record))
          .then((result) => {
            if (result) onSaved(result.id)
          })
      }}
      aria-busy={operation.pending}
    >
      <TextField
        label={copy('Website name', 'websites')}
        required
        maxLength={200}
        value={draft.name}
        disabled={operation.pending}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <TextField
        label={copy('Website URL', 'websites')}
        required
        maxLength={2048}
        value={draft.url}
        disabled={operation.pending}
        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        description={copy(
          'Use a domain or an HTTP/HTTPS URL. Subdomains and paths are preserved. Credentials, query parameters and fragments are not accepted. International domains use their ASCII (punycode) form.',
          'websites',
        )}
      />
      <label className="grid gap-2">
        <span className="font-semibold">{copy('Description', 'websites')}</span>
        <textarea
          className="ui-input min-h-24"
          maxLength={4000}
          value={draft.description}
          disabled={operation.pending}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
      {copy(operation.error, 'websites') ? (
        <p role="alert" className="text-danger-ink">
          {copy(
            '{{value1}} Reload current data before another attempt if the result is uncertain.',
            'websites',
            { value1: copy(operation.error, 'websites') },
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={operation.pending}
          disabled={
            operation.pending || !draft.name.trim() || !draft.url.trim()
          }
        >
          {copy('Save website', 'websites')}
        </Button>
        <Button onClick={onCancel} disabled={operation.pending}>
          {copy('Cancel', 'websites')}
        </Button>
      </div>
    </form>
  )
}
