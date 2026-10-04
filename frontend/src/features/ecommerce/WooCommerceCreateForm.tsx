import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, TextField } from '../../components/ui'
import type { Operation } from '../integrations/hooks'
import * as service from './service'

export function WooCommerceCreateForm({ operation }: { operation: Operation }) {
  const [origin, setOrigin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const navigate = useNavigate()
  const blocked = operation.pending || !!operation.error
  return <form className="my-5 grid gap-3 rounded-md border border-line bg-surface p-5" onSubmit={e => {
    e.preventDefault()
    if (blocked || !confirmed || !service.validOrigin(origin)) return
    setConfirmed(false)
    void operation.run(() => service.create(operation.clientID, origin)).then(result => {
      if (result) void navigate(`/app/clients/${operation.clientID}/integrations/${result.id}`)
    })
  }}>
    <h2 className="font-semibold">Add WooCommerce store</h2>
    <p className="text-sm text-muted">Create a pending connection, then install the store's dedicated Read key. The HTTPS store origin is permanently bound to this client. Creating a connection does not verify store access.</p>
    <TextField label="WooCommerce HTTPS origin" autoComplete="off" type="url" required maxLength={520} placeholder="https://shop.example.com" value={origin} disabled={blocked} onChange={e => setOrigin(e.target.value)} />
    <p className="text-xs text-muted">Use a public HTTPS origin, optionally with the WordPress base path. Omit trailing slashes, API endpoints, ports, queries and credentials.</p>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={blocked} onChange={e => setConfirmed(e.target.checked)} />I am authorized to read this store and permanently bind it to this client.</label>
    {operation.error ? <p role="alert">{operation.error} Reload current data before another attempt; the outcome may be uncertain.</p> : null}
    <Button type="submit" loading={operation.pending} disabled={blocked || !confirmed || !service.validOrigin(origin)}>Add pending store</Button>
  </form>
}
