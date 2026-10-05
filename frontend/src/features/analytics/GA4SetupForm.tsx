import { useId, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import type { Connection } from '../integrations/models'
import type { Operation } from '../integrations/hooks'
import { PeriodFields } from './PeriodFields'
import { validPeriod } from './models'
import type { Period } from './models'
import * as service from './service'

export function GA4SetupForm({ record, operation, onQueued }: { record: Connection; operation: Operation; onQueued: (period: Period) => void }) {
  const [period, setPeriod] = useState<Period>({ since: '', until: '' })
  const [confirmed, setConfirmed] = useState(false)
  const [validation, setValidation] = useState('')
  const secret = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const blocked = operation.pending || !!operation.error
  const replacing = record.state !== 'pending'
  async function submit(install: boolean) {
    if (blocked || !validPeriod(period) || install && !confirmed) return
    const credential = install ? secret.current?.value ?? '' : undefined
    // Never retain the key in React state, cache, storage or an error message.
    if (secret.current) secret.current.value = ''
    setValidation('')
    if (install && (!credential || new TextEncoder().encode(credential).length > 16384)) {
      setValidation('Enter a service-account JSON key of at most 16 KiB. The field has been cleared.')
      return
    }
    setConfirmed(false)
    const result = await operation.run(() => service.queue(record, period, credential))
    if (result) {
      await operation.cache.invalidateQueries({ queryKey: ['analytics'] })
      onQueued(period)
    }
  }
  return <form className="mt-5 grid gap-4 form-section" onSubmit={e => { e.preventDefault(); void submit(true) }}>
    <h2 className="font-semibold">GA4 setup and synchronization</h2>
    <p className="text-sm leading-6 text-muted">Grant the service account Viewer access to this GA4 property and enable the Analytics Admin and Data APIs in its Google Cloud project. Use a property that excludes personal data. A background worker verifies access and collects reports; saving a key alone does not verify the connection.</p>
    <PeriodFields period={period} onChange={setPeriod} disabled={blocked} />
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-semibold">Service-account JSON key</label>
      <p id={id + '-help'} className="text-xs text-muted">At most 16 KiB. Sent over this application's authenticated connection for encrypted storage. Cleared on submission and when this form closes. Never place keys in URLs.</p>
      <textarea ref={secret} id={id} aria-describedby={id + '-help'} className="ui-input min-h-32 font-mono text-xs" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} maxLength={16384} disabled={blocked} />
    </div>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={e => setConfirmed(e.target.checked)} /><span>{replacing ? 'Replace the saved credential and cancel older queued work. Reports from the previous credential will become unavailable.' : 'Install this credential for the property bound to this client.'}</span></label>
    {validation ? <p role="alert">{validation}</p> : null}
    <div className="flex flex-wrap gap-3">
      <Button type="submit" loading={operation.pending} disabled={blocked || !confirmed || !validPeriod(period)}>{replacing ? 'Replace key and queue sync' : 'Install key and queue sync'}</Button>
      {record.state === 'connected' ? <Button disabled={blocked || !validPeriod(period)} onClick={() => void submit(false)}>Queue sync with saved key</Button> : null}
    </div>
    <p className="text-xs text-muted">Only the selected property dates are collected. Reload the connection before another request if the result is uncertain. No automatic write retry.</p>
  </form>
}
