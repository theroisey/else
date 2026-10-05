import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n/index'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  PageHeader,
  PageSkeleton,
  Status,
  buttonStyles,
} from '../../components/ui'
import { ClientNavigation } from '../clients/ClientNavigation'
import { useClients } from '../clients/hooks'
import { AccessDenied, ClientError } from '../clients/Shared'
import { isUUID } from '../auth/session'
import { hasPermission } from '../auth/permissions'
import { formatTime } from '../../lib/time'
import * as clients from '../clients/service'
import * as integrations from '../integrations/service'
import { providerLabels } from '../integrations/models'
import * as api from './service'
import type { Website } from './service'
import { WebsiteForm } from './WebsiteForm'

export function WebsitePage() {
  useLocale()
  const { id = '', websiteID = '', websiteModule = '' } = useParams()
  if (!isUUID(id) || !isUUID(websiteID))
    return (
      <h1 className="page-title">
        {copy('Website page not found', 'websites')}
      </h1>
    )
  return (
    <WebsiteWorkspace
      key={`${id}/${websiteID}/${websiteModule}`}
      clientID={id}
      websiteID={websiteID}
      module={websiteModule}
    />
  )
}
function WebsiteWorkspace({
  clientID,
  websiteID,
  module,
}: {
  clientID: string
  websiteID: string
  module: string
}) {
  useLocale()
  const operation = useClients()
  const grants = operation.auth.session?.user.permissions ?? []
  const has = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID })
  const view = has('clients.view')
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<{
    record: Website
    action: 'primary' | 'archive'
  } | null>(null)
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState([''])
  const [availableHistory, setAvailableHistory] = useState([''])
  const [connection, setConnection] = useState('')
  const [bindingConfirmed, setBindingConfirmed] = useState(false)
  const query = useQuery({
    queryKey: [...operation.key, 'website', clientID, websiteID],
    enabled: view,
    queryFn: ({ signal }) =>
      operation.read(() => api.detail(clientID, websiteID, signal)),
  })
  const client = useQuery({
    queryKey: [...operation.key, 'detail', clientID],
    enabled: view,
    queryFn: ({ signal }) =>
      operation.read(() => clients.client(clientID, signal)),
  })
  const canReports = has('analytics.view'),
    canIntegrations = has('integrations.view'),
    canActivity = has('activity.view')
  const members = useQuery({
    queryKey: [
      ...operation.key,
      'website-connections',
      clientID,
      websiteID,
      history.at(-1),
    ],
    enabled: view && (canReports || canIntegrations) && module !== 'activity',
    queryFn: ({ signal }) =>
      operation.read(() =>
        api.connections(clientID, websiteID, history.at(-1)!, signal),
      ),
  })
  const activity = useQuery({
    queryKey: [
      ...operation.key,
      'website-activity',
      clientID,
      websiteID,
      history.at(-1),
    ],
    enabled: view && canActivity && module === 'activity',
    queryFn: ({ signal }) =>
      operation.read(() =>
        api.activity(clientID, websiteID, history.at(-1)!, signal),
      ),
  })
  const available = useQuery({
    queryKey: [
      ...operation.key,
      'website-binding-options',
      clientID,
      availableHistory.at(-1),
    ],
    enabled:
      view &&
      canIntegrations &&
      has('integrations.manage') &&
      module === 'integrations',
    queryFn: ({ signal }) =>
      operation.read(() =>
        integrations.list(clientID, availableHistory.at(-1)!, signal),
      ),
  })
  const record = query.data
  const active = record?.status === 'active' && client.data?.status === 'active'
  const manage = active && has('clients.update'),
    archive = active && has('clients.archive'),
    bind = active && canIntegrations && has('integrations.manage')
  const base = api.websiteBase(clientID, websiteID)
  const labels: Record<string, string> = {
    analytics: copy('Web analytics', 'websites'),
    commerce: copy('Commerce', 'websites'),
    marketing: copy('Marketing', 'websites'),
    integrations: copy('Integrations', 'websites'),
    activity: copy('Activity', 'websites'),
  }
  const provider =
    module === 'analytics'
      ? 'ga4'
      : module === 'commerce'
        ? 'woocommerce'
        : module === 'marketing'
          ? 'meta_ads'
          : null
  const current = module === 'activity' ? activity : members
  const rows =
    members.data?.data.filter((v) => !provider || v.provider === provider) ?? []
  const reportPath = (provider: string) =>
    provider === 'ga4'
      ? 'analytics'
      : provider === 'woocommerce'
        ? 'commerce'
        : 'marketing'
  const refresh = () => {
    operation.clearError()
    setConnection('')
    setBindingConfirmed(false)
    void query.refetch()
    void client.refetch()
    if (current.isEnabled) void current.refetch()
    if (available.isEnabled) void available.refetch()
  }
  if (
    module &&
    ![
      'analytics',
      'commerce',
      'marketing',
      'integrations',
      'activity',
    ].includes(module)
  )
    return (
      <section>
        <h1 className="page-title">
          {copy('Website page not found', 'websites')}
        </h1>
      </section>
    )
  if (
    !view ||
    (module === 'activity' && !canActivity) ||
    (module === 'integrations' && !canIntegrations) ||
    (provider && !canReports)
  )
    return <AccessDenied />
  if (query.isPending || client.isPending)
    return (
      <PageSkeleton label={copy('Loading website workspace…', 'websites')} />
    )
  if (query.isError || client.isError)
    return <ClientError error={query.error ?? client.error} retry={refresh} />
  if (!record) return null
  return (
    <section>
      <PageHeader
        eyebrow={client.data.name}
        title={record.name}
        description={
          labels[module] ??
          (record.description || copy('Website overview', 'websites'))
        }
      >
        <Button
          disabled={query.isFetching || operation.pending}
          onClick={refresh}
        >
          {copy('Refresh website', 'websites')}
        </Button>
        {manage && !module ? (
          <Button onClick={() => setEditing(true)}>
            {copy('Edit website', 'websites')}
          </Button>
        ) : null}
      </PageHeader>
      <ClientNavigation clientID={clientID} />
      {!active ? (
        <p className="mb-5 border-l-2 border-line-strong pl-4 text-sm text-muted">
          {copy(
            'This website or its client is archived. History and stored reports remain available; changes are unavailable.',
            'websites',
          )}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-5" role="status">
          {copy(notice, 'websites')}
        </p>
      ) : null}
      {copy(operation.error, 'websites') ? (
        <p className="mb-5 text-danger-ink" role="alert">
          {copy(
            '{{value1}} Reload current data before another attempt.',
            'websites',
            { value1: copy(operation.error, 'websites') },
          )}
        </p>
      ) : null}
      {!module ? (
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <section className="workspace-section">
            <h2 className="font-semibold">
              {copy('Property details', 'websites')}
            </h2>
            <dl className="mt-5 grid gap-5 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted">
                  {copy('Domain', 'websites')}
                </dt>
                <dd className="mt-1 break-all">
                  {record.domain || copy('Review required', 'websites')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">
                  {copy('Status', 'websites')}
                </dt>
                <dd className="mt-1">
                  <Status
                    tone={
                      record.needs_review
                        ? 'warning'
                        : active
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {record.needs_review
                      ? copy('Review legacy URL', 'websites')
                      : record.status === 'active'
                        ? copy('Active', 'websites')
                        : copy('Archived', 'websites')}
                  </Status>
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-xs text-muted">
                  {copy('Website URL', 'websites')}
                </dt>
                <dd className="mt-1 break-all">{record.url}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">
                  {copy('Primary website', 'websites')}
                </dt>
                <dd className="mt-1">
                  {record.is_primary
                    ? copy('Yes', 'websites')
                    : copy('No', 'websites')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">
                  {copy('Last updated', 'websites')}
                </dt>
                <dd className="mt-1">{formatTime(record.updated_at)}</dd>
              </div>
            </dl>
            {record.needs_review ? (
              <p className="mt-5 text-sm text-warning-ink">
                {copy(
                  'The original website value was preserved during migration. Edit and validate it before setting it as primary.',
                  'websites',
                )}
              </p>
            ) : null}
          </section>
          <aside className="context-rail">
            <h2 className="eyebrow">
              {copy('Website management', 'websites')}
            </h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              {copy(
                'Client finance, pricing and general operations remain in the client workspace. Reports here belong only to explicitly assigned connections.',
                'websites',
              )}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {manage && !record.is_primary && !record.needs_review ? (
                <Button
                  onClick={() => setConfirm({ record, action: 'primary' })}
                >
                  {copy('Set as primary', 'websites')}
                </Button>
              ) : null}
              {archive ? (
                <Button
                  variant="danger"
                  onClick={() => setConfirm({ record, action: 'archive' })}
                >
                  {copy('Archive website', 'websites')}
                </Button>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
      {module === 'activity' ? (
        <section className="workspace-section">
          <h2 className="font-semibold">
            {copy('Recorded website changes', 'websites')}
          </h2>
          {activity.isPending ? (
            <PageSkeleton
              label={copy('Loading website activity…', 'websites')}
            />
          ) : activity.isError ? (
            <ClientError error={activity.error} retry={refresh} />
          ) : activity.data.data.length ? (
            <ol className="mt-5 divide-y divide-line">
              {activity.data.data.map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap justify-between gap-3 py-3"
                >
                  <span>{copy(v.summary, 'websites')}</span>
                  <time className="text-xs text-muted" dateTime={v.occurred_at}>
                    {formatTime(v.occurred_at)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-muted">
              {copy('No recorded website changes in this view.', 'websites')}
            </p>
          )}
        </section>
      ) : canReports || canIntegrations ? (
        <section className="workspace-section mt-6">
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="font-semibold">
              {provider
                ? copy(labels[module], 'websites')
                : copy('Assigned integrations', 'websites')}
            </h2>
            {canIntegrations ? (
              <Link
                className="text-xs underline underline-offset-4"
                to={base + '/integrations'}
              >
                {copy('Manage assignments', 'websites')}
              </Link>
            ) : null}
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            {copy(
              'Only connections assigned to this website are shown. Client-wide provider views list every connection separately; totals across unrelated properties are not combined.',
              'websites',
            )}
          </p>
          {members.isPending ? (
            <PageSkeleton
              label={copy('Loading website connections…', 'websites')}
            />
          ) : members.isError ? (
            <ClientError error={members.error} retry={refresh} />
          ) : rows.length ? (
            <ul className="mt-4 divide-y divide-line">
              {rows.map((c) => (
                <li
                  key={c.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-4 py-4"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {copy(providerLabels[c.provider], 'websites')}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      {c.id}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Status tone="neutral">{statusLabel(c.state)}</Status>
                    {canReports ? (
                      <Link
                        className={buttonStyles()}
                        to={`${base}/${reportPath(c.provider)}/${c.id}`}
                      >
                        {copy('Open reports', 'websites')}
                      </Link>
                    ) : null}
                    {canIntegrations ? (
                      <Link
                        className={buttonStyles()}
                        to={`${base}/integrations/${c.id}`}
                      >
                        {copy('Connection setup', 'websites')}
                      </Link>
                    ) : null}
                    {bind && module === 'integrations' ? (
                      <Button
                        disabled={operation.pending}
                        onClick={() => {
                          if (!record) return
                          void operation
                            .run(() => api.bind(record, c.id, false))
                            .then((result) => {
                              if (result)
                                setNotice(
                                  'Connection assignment removed. Provider access and stored reports remain unchanged.',
                                )
                            })
                        }}
                      >
                        {copy('Remove assignment', 'websites')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-muted">
              {copy(
                'No assigned connections in this view. An integration manager can assign an existing client connection.',
                'websites',
              )}
            </p>
          )}
        </section>
      ) : null}
      {bind && module === 'integrations' ? (
        <form
          className="form-section mt-6 grid max-w-3xl gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!connection || !bindingConfirmed || operation.pending) return
            void operation
              .run(() => api.bind(record, connection, true))
              .then((result) => {
                if (result) {
                  setNotice('Connection assigned to this website.')
                  setConnection('')
                  setBindingConfirmed(false)
                }
              })
          }}
        >
          <h2 className="font-semibold">
            {copy('Assign a client connection', 'websites')}
          </h2>
          <p className="text-sm text-muted">
            {copy(
              'Connections retain their original client ownership. To move an assignment, remove it from the current website first. Assign Meta accounts only when their data genuinely belongs to this property.',
              'websites',
            )}
          </p>
          <label className="grid gap-2">
            <span className="font-semibold">
              {copy('Client connection', 'websites')}
            </span>
            <select
              className="ui-input"
              value={connection}
              disabled={operation.pending || available.isFetching}
              onChange={(e) => {
                setConnection(e.target.value)
                setBindingConfirmed(false)
              }}
            >
              <option value="">
                {copy('Select a connection', 'websites')}
              </option>
              {available.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {copy(providerLabels[c.provider], 'websites')} · {c.id}
                </option>
              ))}
            </select>
          </label>
          {available.isError ? (
            <ClientError error={available.error} retry={refresh} />
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={availableHistory.length === 1 || available.isFetching}
              onClick={() => {
                setAvailableHistory((v) => v.slice(0, -1))
                setConnection('')
              }}
            >
              {copy('Previous connections', 'websites')}
            </Button>
            <Button
              disabled={
                !available.data?.page.next_cursor || available.isFetching
              }
              onClick={() => {
                if (available.data?.page.next_cursor)
                  setAvailableHistory((v) => [
                    ...v,
                    available.data.page.next_cursor!,
                  ])
                setConnection('')
              }}
            >
              {copy('More connections', 'websites')}
            </Button>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={bindingConfirmed}
              disabled={operation.pending}
              onChange={(e) => setBindingConfirmed(e.target.checked)}
            />
            <span>
              {copy(
                "I confirm that this connection's data belongs to this website.",
                'websites',
              )}
            </span>
          </label>
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="primary"
              loading={operation.pending}
              disabled={operation.pending || !connection || !bindingConfirmed}
            >
              {copy('Assign connection', 'websites')}
            </Button>
            <Link
              className={buttonStyles()}
              to={`/app/clients/${clientID}/integrations`}
            >
              {copy('Add or manage client connections', 'websites')}
            </Link>
          </div>
        </form>
      ) : null}
      {module && (canReports || canIntegrations || module === 'activity') ? (
        <div className="mt-5 flex justify-between gap-3">
          <Button
            disabled={history.length === 1 || current.isFetching}
            onClick={() => setHistory((v) => v.slice(0, -1))}
          >
            {copy('Previous', 'websites')}
          </Button>
          <Button
            disabled={!current.data?.page.next_cursor || current.isFetching}
            onClick={() => {
              if (current.data?.page.next_cursor)
                setHistory((v) => [...v, current.data.page.next_cursor!])
            }}
          >
            {copy('Next', 'websites')}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={editing}
        onClose={() => {
          if (!operation.pending) setEditing(false)
        }}
        title={copy('Edit website', 'websites')}
        description={copy(
          'Update this property without changing another website.',
          'websites',
        )}
        variant="drawer"
      >
        <WebsiteForm
          clientID={clientID}
          record={record}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </Dialog>
      <Dialog
        open={!!confirm}
        onClose={() => {
          if (!operation.pending) setConfirm(null)
        }}
        title={
          confirm?.action === 'archive'
            ? copy('Archive website', 'websites')
            : copy('Set primary website', 'websites')
        }
        description={
          confirm?.action === 'archive'
            ? copy(
                'Retain this property and its history. Website editing and new assignments will be unavailable.',
                'websites',
              )
            : copy(
                'This property becomes the primary website. Any previous primary remains in the portfolio.',
                'websites',
              )
        }
      >
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            variant={confirm?.action === 'archive' ? 'danger' : 'primary'}
            disabled={operation.pending || !!operation.error}
            loading={operation.pending}
            onClick={() => {
              if (!confirm) return
              void operation
                .run(() => api.action(confirm.record, confirm.action))
                .then((result) => {
                  if (result) {
                    setNotice(
                      confirm.action === 'archive'
                        ? 'Website archived.'
                        : 'Primary website updated.',
                    )
                    setConfirm(null)
                  }
                })
            }}
          >
            {copy('Confirm', 'websites')}
          </Button>
          <Button disabled={operation.pending} onClick={() => setConfirm(null)}>
            {copy('Cancel', 'websites')}
          </Button>
        </div>
      </Dialog>
    </section>
  )
}
