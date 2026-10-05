import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../../components/ui'
import type { Operation } from '../integrations/hooks'
import * as service from './service'

export function WooCommerceCreateForm({ operation }: { operation: Operation }) {
  useLocale()
  const [origin, setOrigin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const navigate = useNavigate()
  const blocked = operation.pending || !!operation.error
  return (
    <form
      className="my-5 grid gap-3 form-section"
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked || !confirmed || !service.validOrigin(origin)) return
        setConfirmed(false)
        void operation
          .run(() => service.create(operation.clientID, origin))
          .then((result) => {
            if (result)
              void navigate(
                `/app/clients/${operation.clientID}/integrations/${result.id}`,
              )
          })
      }}
    >
      <h2 className="font-semibold">
        {copy('Add WooCommerce store', 'commerce')}
      </h2>
      <p className="text-sm text-muted">
        {copy(
          "Create a pending connection, then install the store's dedicated Read key. The HTTPS store origin is permanently bound to this client. Creating a connection does not verify store access.",
          'commerce',
        )}
      </p>
      <TextField
        label={copy('WooCommerce HTTPS origin', 'commerce')}
        autoComplete="off"
        type="url"
        required
        maxLength={520}
        placeholder={'https://shop.example.com'}
        value={origin}
        disabled={blocked}
        onChange={(e) => setOrigin(e.target.value)}
      />
      <p className="text-xs text-muted">
        {copy(
          'Use a public HTTPS origin, optionally with the WordPress base path. Omit trailing slashes, API endpoints, ports, queries and credentials.',
          'commerce',
        )}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {copy(
          'I am authorized to read this store and permanently bind it to this client.',
          'commerce',
        )}
      </label>
      {copy(operation.error, 'commerce') ? (
        <p role="alert">
          {copy(
            '{{value1}} Reload current data before another attempt; the outcome may be uncertain.',
            'commerce',
            { value1: operation.error },
          )}
        </p>
      ) : null}
      <Button
        type="submit"
        loading={operation.pending}
        disabled={blocked || !confirmed || !service.validOrigin(origin)}
      >
        {copy('Add pending store', 'commerce')}
      </Button>
    </form>
  )
}
