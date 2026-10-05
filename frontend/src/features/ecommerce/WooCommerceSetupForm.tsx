import { copy, useLocale } from '../../i18n/index'
import { useParams } from 'react-router'
import { useEffect, useRef, useState } from 'react'
import { Button, TextField } from '../../components/ui'
import type { Connection } from '../integrations/models'
import type { Operation } from '../integrations/hooks'
import { PeriodFields } from './PeriodFields'
import { validPeriod } from './models'
import type { Period } from './models'
import * as service from './service'

export function WooCommerceSetupForm({
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
  const [period, setPeriod] = useState<Period>({
    start: '',
    end: '',
    currency: 'USD',
  })
  const [confirmed, setConfirmed] = useState(false)
  const [validation, setValidation] = useState('')
  const consumerKey = useRef<HTMLInputElement>(null)
  const consumerSecret = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const key = consumerKey.current,
      secret = consumerSecret.current
    return () => {
      if (key) key.value = ''
      if (secret) secret.value = ''
    }
  }, [])
  const blocked = operation.pending || !!operation.error
  async function submit(install: boolean) {
    if (blocked || !validPeriod(period) || (install && !confirmed)) return
    const credential = install
      ? {
          consumer_key: consumerKey.current?.value ?? '',
          consumer_secret: consumerSecret.current?.value ?? '',
        }
      : undefined
    // No React state, cache, browser storage, URL or error retains either key.
    if (consumerKey.current) consumerKey.current.value = ''
    if (consumerSecret.current) consumerSecret.current.value = ''
    setValidation('')
    setConfirmed(false)
    if (
      credential &&
      (!/^ck_[0-9a-f]{40}$/.test(credential.consumer_key) ||
        !/^cs_[0-9a-f]{40}$/.test(credential.consumer_secret) ||
        /^ck_0+$/.test(credential.consumer_key) ||
        /^cs_0+$/.test(credential.consumer_secret))
    ) {
      setValidation(
        'Enter the dedicated Read consumer key and secret exactly as provided by WooCommerce. Both fields have been cleared.',
      )
      return
    }
    const result = await operation.run(() =>
      service.queue(record, period, credential, websiteID),
    )
    if (result) {
      await operation.cache.invalidateQueries({ queryKey: ['commerce'] })
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
        {copy('WooCommerce setup and synchronization', 'commerce')}
      </h2>
      <p className="text-sm leading-6 text-muted">
        {copy('Create a dedicated REST API key with', 'commerce')}{' '}
        <strong>{copy('Read', 'commerce')}</strong>{' '}
        {copy(
          "permission in this store's WooCommerce settings. Use only the key for this immutable store connection. Saving locally encrypts the key and queues background collection; store access is verified only by a successful collection.",
          'commerce',
        )}
      </p>
      <PeriodFields period={period} onChange={setPeriod} disabled={blocked} />
      <TextField
        ref={consumerKey}
        label={copy('Consumer key', 'commerce')}
        type="password"
        autoComplete="new-password"
        maxLength={43}
        disabled={blocked}
      />
      <TextField
        ref={consumerSecret}
        label={copy('Consumer secret', 'commerce')}
        type="password"
        autoComplete="new-password"
        maxLength={43}
        disabled={blocked}
      />
      <p className="text-xs text-muted">
        {copy(
          "Both fields are sent through this application's authenticated connection for encrypted storage. They clear immediately on submission and when the form closes. Never place keys in URLs.",
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
          'I created a dedicated Read key for this store and authorize encrypted storage',
          'commerce',
        )}
        {record.revision !== '1'
          ? copy(' and replacement of the saved key', 'commerce')
          : ''}
        .
      </label>
      {validation ? (
        <p role="alert" className="text-danger-ink">
          {copy(validation, 'commerce')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          loading={operation.pending}
          disabled={blocked || !confirmed || !validPeriod(period)}
        >
          {record.revision === '1'
            ? copy('Save Read key and queue sync', 'commerce')
            : copy('Replace Read key and queue sync', 'commerce')}
        </Button>
        <Button
          type="button"
          disabled={blocked || !validPeriod(period) || record.revision === '1'}
          onClick={() => void submit(false)}
        >
          {copy('Synchronize with saved key', 'commerce')}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {copy(
          'Choose one currency and a complete bounded UTC period. Incomplete, mixed-currency or unavailable reports remain failures. Refresh requires an explicit action; uncertain outcomes must be reviewed by reloading current data.',
          'commerce',
        )}
      </p>
    </form>
  )
}
