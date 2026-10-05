import { copy, useLocale } from '../../i18n/index'
import { useParams } from 'react-router'
import { useEffect, useRef, useState } from 'react'
import { Button, TextField } from '../../components/ui'
import type { Connection } from '../integrations/models'
import type { Operation } from '../integrations/hooks'
import { PeriodFields } from '../analytics/PeriodFields'
import { validPeriod, validToken } from './models'
import type { Period } from './models'
import * as service from './service'

export function MetaSetupForm({
  record,
  operation,
  onQueued,
}: {
  record: Connection
  operation: Operation
  onQueued: () => void
}) {
  useLocale()
  const { websiteID } = useParams()
  const [period, setPeriod] = useState<Period>({ since: '', until: '' })
  const [confirmed, setConfirmed] = useState(false)
  const [validation, setValidation] = useState('')
  const token = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const field = token.current
    return () => {
      if (field) field.value = ''
    }
  }, [])
  const blocked = operation.pending || !!operation.error
  async function submit(install: boolean) {
    if (blocked || !validPeriod(period) || (install && !confirmed)) return
    const credential = install ? (token.current?.value ?? '') : undefined
    if (token.current) token.current.value = ''
    setValidation('')
    setConfirmed(false)
    if (credential !== undefined && !validToken(credential)) {
      setValidation(
        'Enter a user read token of 16–4096 characters without spaces or URLs. The field has been cleared.',
      )
      return
    }
    const result = await operation.run(() =>
      service.queue(record, period, credential, websiteID),
    )
    if (result) {
      await operation.cache.invalidateQueries({ queryKey: ['marketing'] })
      onQueued()
    }
  }
  return (
    <form
      noValidate
      autoComplete="off"
      className="mt-5 grid gap-4 form-section"
      onSubmit={(e) => {
        e.preventDefault()
        void submit(true)
      }}
    >
      <h2 className="font-semibold">
        {copy('Meta setup and synchronization', 'marketing')}
      </h2>
      <p className="text-sm leading-6 text-muted">
        {copy('Provision a user token with', 'marketing')}{' '}
        <strong>ads_read</strong>{' '}
        {copy(
          'permission and access to this ad account through your Meta application. Background collection checks the permission and account. Tokens can expire or be revoked; this application does not refresh them automatically. Applications requiring an app-secret proof need a compatible token configuration.',
          'marketing',
        )}
      </p>
      <PeriodFields
        period={period}
        onChange={setPeriod}
        disabled={blocked}
        calendar={copy('Meta ad-account', 'marketing')}
      />
      <TextField
        ref={token}
        label={copy('Meta user read token', 'marketing')}
        type="password"
        autoComplete="new-password"
        maxLength={4096}
        disabled={blocked}
      />
      <p className="text-xs text-muted">
        {copy(
          "Sent through this application's authenticated connection for encrypted storage. Cleared on submission and when the form closes. Never place tokens in URLs.",
          'marketing',
        )}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={blocked}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {copy(
          'This is an authorized user token with ads_read for this account; I authorize encrypted storage',
          'marketing',
        )}
        {record.revision !== '1'
          ? copy(' and replacement of the saved token', 'marketing')
          : ''}
        .
      </label>
      {validation ? (
        <p role="alert" className="text-danger-ink">
          {copy(validation, 'marketing')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          loading={operation.pending}
          disabled={blocked || !confirmed || !validPeriod(period)}
        >
          {record.revision === '1'
            ? copy('Save read token and queue sync', 'marketing')
            : copy('Replace read token and queue sync', 'marketing')}
        </Button>
        <Button
          type="button"
          disabled={blocked || !validPeriod(period) || record.revision === '1'}
          onClick={() => void submit(false)}
        >
          {copy('Synchronize with saved token', 'marketing')}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {copy(
          "Dates retain the account's timezone, including daylight-saving changes. Saving locally queues verification. Review uncertain outcomes by reloading current data. Disconnect stops local access; revoke the token separately in Meta account settings.",
          'marketing',
        )}
      </p>
    </form>
  )
}
