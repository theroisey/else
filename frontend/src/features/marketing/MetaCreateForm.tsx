import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../../components/ui'
import type { Operation } from '../integrations/hooks'
import * as service from './service'

export function MetaCreateForm({ operation }: { operation: Operation }) {
  useLocale()
  const [account, setAccount] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const navigate = useNavigate()
  const blocked = operation.pending || !!operation.error
  return (
    <form
      className="my-5 grid gap-3 form-section"
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked || !confirmed) return
        void operation
          .run(() => service.create(operation.clientID, account))
          .then((result) => {
            if (result)
              void navigate(
                `/app/clients/${operation.clientID}/integrations/${result.id}`,
              )
          })
      }}
    >
      <h2 className="font-semibold">
        {copy('Add Meta ad account', 'marketing')}
      </h2>
      <p className="text-sm text-muted">
        {copy(
          'Create a pending connection, then install an operator-provisioned user token with ads_read access. The account is permanently bound to this client; saving metadata does not verify access.',
          'marketing',
        )}
      </p>
      <TextField
        label={copy('Meta ad account ID', 'marketing')}
        autoComplete="off"
        inputMode="numeric"
        required
        pattern="[1-9][0-9]{0,19}"
        maxLength={20}
        value={account}
        disabled={blocked}
        onChange={(e) => setAccount(e.target.value)}
      />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {copy(
          'I am authorized to read this ad account for this client.',
          'marketing',
        )}
      </label>
      {copy(operation.error, 'marketing') ? (
        <p role="alert">
          {copy(
            '{{value1}} Reload current data before another attempt; the outcome may be uncertain.',
            'marketing',
            { value1: operation.error },
          )}
        </p>
      ) : null}
      <Button
        type="submit"
        loading={operation.pending}
        disabled={blocked || !confirmed || !/^[1-9][0-9]{0,19}$/.test(account)}
      >
        {copy('Add pending ad account', 'marketing')}
      </Button>
    </form>
  )
}
