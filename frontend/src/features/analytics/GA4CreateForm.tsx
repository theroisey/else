import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../../components/ui'
import type { Operation } from '../integrations/hooks'
import * as service from './service'

export function GA4CreateForm({ operation }: { operation: Operation }) {
  useLocale()
  const [property, setProperty] = useState('')
  const navigate = useNavigate()
  return (
    <form
      className="my-5 grid gap-3 form-section"
      onSubmit={(e) => {
        e.preventDefault()
        if (operation.pending || operation.error) return
        void operation
          .run(() => service.create(operation.clientID, property))
          .then((result) => {
            if (result)
              void navigate(
                `/app/clients/${operation.clientID}/integrations/${result.id}`,
              )
          })
      }}
    >
      <h2 className="font-semibold">{copy('Add GA4 property', 'analytics')}</h2>
      <p className="text-sm text-muted">
        {copy(
          'Create a pending connection, then install a read-only service-account key. The property is permanently bound to this client. Verify you are authorized to read its data.',
          'analytics',
        )}
      </p>
      <TextField
        label={copy('GA4 property ID', 'analytics')}
        autoComplete="off"
        inputMode="numeric"
        required
        pattern="[1-9][0-9]{0,19}"
        maxLength={20}
        value={property}
        disabled={operation.pending || !!copy(operation.error, 'analytics')}
        onChange={(e) => setProperty(e.target.value)}
      />
      {copy(operation.error, 'analytics') ? (
        <p role="alert">
          {copy(
            '{{value1}} Reload current data before another attempt; the outcome may be uncertain.',
            'analytics',
            { value1: operation.error },
          )}
        </p>
      ) : null}
      <Button
        type="submit"
        loading={operation.pending}
        disabled={!!operation.error || !/^[1-9][0-9]{0,19}$/.test(property)}
      >
        {copy('Add pending property', 'analytics')}
      </Button>
    </form>
  )
}
