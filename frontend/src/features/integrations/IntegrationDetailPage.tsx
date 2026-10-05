import { copy, useLocale } from '../../i18n/index'
import { websiteBase, detail as websiteDetail } from '../websites/service'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, Dialog, PageSkeleton } from '../../components/ui'
import { isUUID } from '../auth/session'
import { AccessDenied } from '../clients/Shared'
import { useIntegrations, useIntegrationClient } from './hooks'
import type { Operation } from './hooks'
import { canDisable, providerLabels } from './models'
import type { Connection } from './models'
import {
  IntegrationError,
  IntegrationHeader,
  IntegrationState,
  ManualAction,
} from './Shared'
import * as service from './service'
import { formatTime } from '../../lib/time'
import { GA4SetupForm } from '../analytics/GA4SetupForm'
import { WooCommerceSetupForm } from '../ecommerce/WooCommerceSetupForm'
import { MetaSetupForm } from '../marketing/MetaSetupForm'
import { hasPermission } from '../auth/permissions'

export function IntegrationDetailPage() {
  useLocale()
  const { id: clientID = '', connectionID = '' } = useParams()
  const operation = useIntegrations(clientID)
  if (!isUUID(clientID) || !isUUID(connectionID))
    return (
      <h1 className="page-title">
        {copy('Integration not found', 'integrations')}
      </h1>
    )
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
  useLocale()
  const { websiteID } = useParams()
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
    queryKey: [...operation.key, 'detail', websiteID, id],
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: !confirm && !operation.pending,
    queryFn: ({ signal }) =>
      operation.read(() =>
        service.detail(operation.clientID, id, signal, websiteID),
      ),
  })
  const website = useQuery({
    queryKey: [...operation.key, 'website-context', websiteID],
    enabled: !!websiteID,
    queryFn: ({ signal }) =>
      operation.read(() =>
        websiteDetail(operation.clientID, websiteID!, signal),
      ),
    retry: false,
  })
  const busy =
    query.isFetching || client.isFetching || (!!websiteID && website.isFetching)
  const failed =
    query.isError || client.isError || (!!websiteID && website.isError)
  const record = !busy && !failed ? query.data : undefined
  const writable =
    !!record &&
    operation.permissions.manage &&
    client.data?.status === 'active' &&
    (!websiteID || website.data?.status === 'active') &&
    canDisable(record)
  async function reload() {
    setConfirm(null)
    setNotice('')
    const [fresh, context, property] = await Promise.all([
      query.refetch(),
      client.refetch(),
      websiteID ? website.refetch() : Promise.resolve({ isSuccess: true }),
    ])
    if (
      mounted.current &&
      fresh.isSuccess &&
      context.isSuccess &&
      property.isSuccess
    )
      operation.clearError()
  }
  async function disable(snapshot: Connection) {
    const result = await operation.run(() =>
      service.disconnect(snapshot, websiteID),
    )
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
        {copy('Reload connection', 'integrations')}
      </Button>
      {notice ? (
        <p role="status" className="mt-4 text-sm">
          {copy(notice, 'integrations')}
        </p>
      ) : null}
      {copy(operation.error, 'integrations') && !confirm ? (
        <div className="mt-4">
          <p role="alert" className="text-danger-ink">
            {copy(
              '{{value1}} The outcome may be uncertain. Reload current data before another attempt.',
              'integrations',
              { value1: operation.error },
            )}
          </p>
        </div>
      ) : null}
      {busy || query.isPending || client.isPending ? (
        <PageSkeleton label={copy('Loading connection…', 'integrations')} />
      ) : failed ? (
        <IntegrationError
          error={
            query.isError
              ? query.error
              : client.isError
                ? client.error
                : website.error
          }
          retry={() => void reload()}
        />
      ) : record ? (
        <>
          {client.data?.status === 'archived' ||
          website.data?.status === 'archived' ? (
            <p role="status" className="mt-4 text-sm text-muted">
              {copy(
                'This client or website is archived. Connection history remains readable; changes are unavailable.',
                'integrations',
              )}
            </p>
          ) : null}
          <div className="mt-5 form-section">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h2 className="text-lg font-semibold">
                {copy(providerLabels[record.provider], 'integrations')}
              </h2>
              <IntegrationState record={record} />
            </div>
            <dl className="mt-5 grid gap-5 text-sm sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted">
                  {copy('Connection reference', 'integrations')}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {record.id}
                </dd>
              </div>
              <div>
                <dt className="text-muted">
                  {copy('Created (Europe/Istanbul)', 'integrations')}
                </dt>
                <dd className="mt-1 break-all">
                  <time dateTime={record.created_at}>
                    {formatTime(record.created_at, 'Europe/Istanbul')}
                  </time>
                </dd>
              </div>
              <div>
                <dt className="text-muted">
                  {copy(
                    'Last metadata change (Europe/Istanbul)',
                    'integrations',
                  )}
                </dt>
                <dd className="mt-1 break-all">
                  <time dateTime={record.updated_at}>
                    {formatTime(record.updated_at, 'Europe/Istanbul')}
                  </time>
                </dd>
              </div>
            </dl>
          </div>
          {record.state === 'revocation_failed' ? (
            <ManualAction provider={record.provider} />
          ) : null}
          {record.provider === 'ga4' &&
          hasPermission(operation.auth.session?.user.permissions ?? [], {
            permission: 'analytics.view',
            scope: 'client',
            clientID: operation.clientID,
          }) ? (
            <Link
              className="mt-4 block underline underline-offset-4"
              to={`${websiteBase(operation.clientID, websiteID)}/analytics/${record.id}`}
            >
              {copy('View GA4 reports', 'integrations')}
            </Link>
          ) : null}
          {record.provider === 'ga4' &&
          writable &&
          ['pending', 'connected', 'reauthorization_required'].includes(
            record.state,
          ) ? (
            <GA4SetupForm
              key={record.revision}
              record={record}
              operation={operation}
              onQueued={() =>
                setNotice(
                  'GA4 synchronization queued. Reload the reports to check progress; provider access is not yet verified.',
                )
              }
            />
          ) : null}
          {record.provider === 'woocommerce' &&
          hasPermission(operation.auth.session?.user.permissions ?? [], {
            permission: 'analytics.view',
            scope: 'client',
            clientID: operation.clientID,
          }) ? (
            <Link
              className="mt-4 block underline underline-offset-4"
              to={`${websiteBase(operation.clientID, websiteID)}/commerce/${record.id}`}
            >
              {copy('View WooCommerce reports', 'integrations')}
            </Link>
          ) : null}
          {record.provider === 'woocommerce' &&
          writable &&
          ['pending', 'connected', 'reauthorization_required'].includes(
            record.state,
          ) ? (
            <WooCommerceSetupForm
              key={record.revision}
              record={record}
              operation={operation}
              onQueued={() =>
                setNotice(
                  'WooCommerce synchronization queued. Reload the stored reports to check progress; store access is not yet verified.',
                )
              }
            />
          ) : null}
          {record.provider === 'meta_ads' &&
          hasPermission(operation.auth.session?.user.permissions ?? [], {
            permission: 'analytics.view',
            scope: 'client',
            clientID: operation.clientID,
          }) ? (
            <Link
              className="mt-4 block underline underline-offset-4"
              to={`${websiteBase(operation.clientID, websiteID)}/marketing/${record.id}`}
            >
              {copy('View Meta reports', 'integrations')}
            </Link>
          ) : null}
          {record.provider === 'meta_ads' &&
          writable &&
          ['pending', 'connected', 'reauthorization_required'].includes(
            record.state,
          ) ? (
            <MetaSetupForm
              key={record.revision}
              record={record}
              operation={operation}
              onQueued={() =>
                setNotice(
                  'Meta synchronization queued. Reload the stored reports to check progress; account access is not yet verified.',
                )
              }
            />
          ) : null}
          {writable ? (
            <div className="mt-5 border-t border-line pt-5">
              <h2 className="font-semibold">
                {copy('Disable local use', 'integrations')}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                {copy(
                  "Stop this application's local credential use. Remote provider access requires a separate manual action.",
                  'integrations',
                )}
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
                {copy('Disable local use', 'integrations')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {confirm && record && confirm.revision === record.revision && writable ? (
        <Dialog
          open
          title={copy('Disable local use?', 'integrations')}
          description={copy(
            "This stops local credential use immediately. Remote revocation is unavailable. You must also remove this application's access in {{value1}} account settings. Remote access may remain until then.",
            'integrations',
            { value1: providerLabels[record.provider] },
          )}
          onClose={() => {
            if (!operation.pending) setConfirm(null)
          }}
        >
          <p className="mt-4 break-all font-mono text-xs text-muted">
            {copy('Connection {{value1}}', 'integrations', {
              value1: confirm.id,
            })}
          </p>
          {copy(operation.error, 'integrations') ? (
            <p role="alert" className="mt-4 text-danger-ink">
              {copy(
                '{{value1}} The outcome may be uncertain. Close and reload before another attempt.',
                'integrations',
                { value1: operation.error },
              )}
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
              {copy(operation.error, 'integrations')
                ? copy('Close and reload', 'integrations')
                : copy('Keep local use', 'integrations')}
            </Button>
            <Button
              variant="danger"
              loading={operation.pending}
              disabled={!!operation.error}
              onClick={() => void disable(confirm)}
            >
              {copy('Confirm local disable', 'integrations')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
