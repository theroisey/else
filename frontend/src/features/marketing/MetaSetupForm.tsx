import { useEffect, useRef, useState } from 'react'
import { Button, TextField } from '../../components/ui'
import type { Connection } from '../integrations/models'
import type { Operation } from '../integrations/hooks'
import { PeriodFields } from '../analytics/PeriodFields'
import { validPeriod, validToken } from './models'
import type { Period } from './models'
import * as service from './service'

export function MetaSetupForm({ record, operation, onQueued }: { record: Connection; operation: Operation; onQueued: () => void }) {
  const [period, setPeriod] = useState<Period>({ since: '', until: '' })
  const [confirmed, setConfirmed] = useState(false)
  const [validation, setValidation] = useState('')
  const token = useRef<HTMLInputElement>(null)
  useEffect(() => { const field = token.current; return () => { if (field) field.value = '' } }, [])
  const blocked = operation.pending || !!operation.error
  async function submit(install: boolean) {
    if (blocked || !validPeriod(period) || install && !confirmed) return
    const credential = install ? token.current?.value ?? '' : undefined
    if (token.current) token.current.value = ''
    setValidation(''); setConfirmed(false)
    if (credential !== undefined && !validToken(credential)) {
      setValidation('Enter a user read token of 16–4096 characters without spaces or URLs. The field has been cleared.')
      return
    }
    const result = await operation.run(() => service.queue(record, period, credential))
    if (result) { await operation.cache.invalidateQueries({ queryKey: ['marketing'] }); onQueued() }
  }
  return <form noValidate autoComplete="off" className="mt-5 grid gap-4 rounded-md border border-line bg-surface p-5" onSubmit={e => { e.preventDefault(); void submit(true) }}>
    <h2 className="font-semibold">Meta setup and synchronization</h2>
    <p className="text-sm leading-6 text-muted">Provision a user token with <strong>ads_read</strong> permission and access to this ad account through your Meta application. Background collection checks the permission and account. Tokens can expire or be revoked; this application does not refresh them automatically. Applications requiring an app-secret proof need a compatible token configuration.</p>
    <PeriodFields period={period} onChange={setPeriod} disabled={blocked} calendar="Meta ad-account" />
    <TextField ref={token} label="Meta user read token" type="password" autoComplete="new-password" maxLength={4096} disabled={blocked} />
    <p className="text-xs text-muted">Sent through this application's authenticated connection for encrypted storage. Cleared on submission and when the form closes. Never place tokens in URLs.</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={e => setConfirmed(e.target.checked)} />This is an authorized user token with ads_read for this account; I authorize encrypted storage{record.revision !== '1' ? ' and replacement of the saved token' : ''}.</label>
    {validation ? <p role="alert" className="text-danger-ink">{validation}</p> : null}
    <div className="flex flex-wrap gap-3">
      <Button type="submit" loading={operation.pending} disabled={blocked || !confirmed || !validPeriod(period)}>{record.revision === '1' ? 'Save read token and queue sync' : 'Replace read token and queue sync'}</Button>
      <Button type="button" disabled={blocked || !validPeriod(period) || record.revision === '1'} onClick={() => void submit(false)}>Synchronize with saved token</Button>
    </div>
    <p className="text-xs text-muted">Dates retain the account's timezone, including daylight-saving changes. Saving locally queues verification. Review uncertain outcomes by reloading current data. Disconnect stops local access; revoke the token separately in Meta account settings.</p>
  </form>
}
