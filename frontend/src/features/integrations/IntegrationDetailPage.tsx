import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Dialog } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { useIntegrations, useIntegrationClient } from './hooks'
import type { Operation } from './hooks'
import { canDisable } from './models'
import type { Connection } from './models'
import {
  IntegrationError,
  IntegrationHeader,
  IntegrationState,
  ManualAction,
} from './Shared'
import * as service from './service'

export function IntegrationDetailPage() {
  const { id: clientID = '', connectionID = '' } = useParams()
  const operation = useIntegrations(clientID)
  if (!isUUID(clientID) || !isUUID(connectionID))
    return <h1 className="text-2xl font-semibold">Integration not found</h1>
  if (!operation.permissions.view) return <AccessDenied />
  return (
    <ConnectionDetail
      key={JSON.stringify([...operation.key, connectionID])}
      operation={operation}
      id={connectionID}
    />
  )
}
function ConnectionDetail({
  operation,
  id,
}: {
  operation: Operation
  id: string
}) {
  const [confirm, setConfirm] = useState<Connection | null>(null)
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const client = useIntegrationClient(operation)
  const query = useQuery({
    queryKey: [...operation.key, 'detail', id],
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: !confirm && !operation.pending,
    queryFn: ({ signal }) =>
      operation.read(() => service.detail(operation.clientID, id, signal)),
  })
  const busy = query.isFetching || client.isFetching
  const failed = query.isError || client.isError
  const record = !busy && !failed ? query.data : undefined
  const writable =
    !!record &&
    operation.permissions.manage &&
    client.data?.status === 'active' &&
    canDisable(record)
  async function reload() {
    setConfirm(null)
    setNotice('')
    const [fresh, context] = await Promise.all([
      query.refetch(),
      client.refetch(),
    ])
    if (mounted.current && fresh.isSuccess && context.isSuccess)
      operation.clearError()
  }
  async function disable(snapshot: Connection) {
    const result = await operation.run(() => service.disconnect(snapshot))
    if (!mounted.current) return
    if (result) {
      setConfirm(null)
      setNotice('Local use disabled. Remote revocation remains unverified.')
    }
  }
  return (
    <section className="max-w-4xl">
      <IntegrationHeader
        detail
        clientID={operation.clientID}
        name={!busy && !failed ? client.data?.name : undefined}
      />
      <Button
        disabled={busy || operation.pending}
        onClick={() => void reload()}
      >
        Reload connection
      </Button>
      {notice ? (
        <p role="status" className="mt-4 text-sm">
          {notice}
        </p>
      ) : null}
      {operation.error && !confirm ? (
        <div className="mt-4">
          <p role="alert" className="text-danger-ink">
            {operation.error} The outcome may be uncertain. Reload current data
            before another attempt.
          </p>
        </div>
      ) : null}
      {busy || query.isPending || client.isPending ? (
        <p role="status" className="py-8 text-muted">
          Loading connection…
        </p>
      ) : failed ? (
        <IntegrationError
          error={query.isError ? query.error : client.error}
          retry={() => void reload()}
        />
      ) : record ? (
        <>
          {client.data?.status === 'archived' ? (
            <p role="status" className="mt-4 text-sm text-muted">
              This client is archived. Connection history remains readable;
              changes are unavailable.
            </p>
          ) : null}
          <div className="mt-5 rounded-md border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h2 className="text-lg font-semibold">Meta Ads</h2>
              <IntegrationState record={record} />
            </div>
            <dl className="mt-5 grid gap-5 text-sm sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted">Connection reference</dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {record.id}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Created (UTC)</dt>
                <dd className="mt-1 break-all">
                  <time dateTime={record.created_at}>{record.created_at}</time>
                </dd>
              </div>
              <div>
                <dt className="text-muted">Last metadata change (UTC)</dt>
                <dd className="mt-1 break-all">
                  <time dateTime={record.updated_at}>{record.updated_at}</time>
                </dd>
              </div>
            </dl>
          </div>
          {record.state === 'revocation_failed' ? <ManualAction /> : null}
          {writable ? (
            <div className="mt-5 border-t border-line pt-5">
              <h2 className="font-semibold">Disable local use</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                Stop this application's local credential use. Remote provider
                access requires a separate manual action.
              </p>
              <Button
                variant="danger"
                className="mt-3"
                disabled={operation.pending || !!operation.error}
                onClick={() => {
                  operation.clearError()
                  setConfirm(record)
                }}
              >
                Disable local use
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {confirm && record && confirm.revision === record.revision && writable ? (
        <Dialog
          open
          title="Disable local use?"
          description="This stops local credential use immediately. Remote revocation is unavailable. You must also remove this application's access in Meta's account settings. Remote access may remain until then."
          onClose={() => {
            if (!operation.pending) setConfirm(null)
          }}
        >
          <p className="mt-4 break-all font-mono text-xs text-muted">
            Connection {confirm.id}
          </p>
          {operation.error ? (
            <p role="alert" className="mt-4 text-danger-ink">
              {operation.error} The outcome may be uncertain. Close and reload
              before another attempt.
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              disabled={operation.pending}
              onClick={() => {
                if (operation.error) void reload()
                else setConfirm(null)
              }}
            >
              {operation.error ? 'Close and reload' : 'Keep local use'}
            </Button>
            <Button
              variant="danger"
              loading={operation.pending}
              disabled={!!operation.error}
              onClick={() => void disable(confirm)}
            >
              Confirm local disable
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
