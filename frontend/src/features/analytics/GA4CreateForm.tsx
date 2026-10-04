import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../../components/ui'
import type { Operation } from '../integrations/hooks'
import * as service from './service'

export function GA4CreateForm({ operation }: { operation: Operation }) {
  const [property, setProperty] = useState('')
  const navigate = useNavigate()
  return <form className="my-5 grid gap-3 rounded-md border border-line bg-surface p-5" onSubmit={e => {
    e.preventDefault()
    if (operation.pending || operation.error) return
    void operation.run(() => service.create(operation.clientID, property)).then(result => {
      if (result) void navigate(`/app/clients/${operation.clientID}/integrations/${result.id}`)
    })
  }}>
    <h2 className="font-semibold">Add GA4 property</h2>
    <p className="text-sm text-muted">Create a pending connection, then install a read-only service-account key. The property is permanently bound to this client. Verify you are authorized to read its data.</p>
    <TextField label="GA4 property ID" autoComplete="off" inputMode="numeric" required pattern="[1-9][0-9]{0,19}" maxLength={20} value={property} disabled={operation.pending || !!operation.error} onChange={e => setProperty(e.target.value)} />
    {operation.error ? <p role="alert">{operation.error} Reload current data before another attempt; the outcome may be uncertain.</p> : null}
    <Button type="submit" loading={operation.pending} disabled={!!operation.error || !/^[1-9][0-9]{0,19}$/.test(property)}>Add pending property</Button>
  </form>
}
