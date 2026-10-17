import { MCPActivity } from './MCPActivity'
import { useState } from 'react'
import { formatDate } from '../../i18n/format'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import { Button, TextField, PageSkeleton } from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsError } from '../operations/Shared'
import { authenticatedJSON } from '../../services/authenticated'
import { status, page, applicationSchema, grantSchema } from './service'
export function MCPSettings() {
  useLocale()
  const op = useRecordOperations('mcp')
  const [cursor, setCursor] = useState<string>()
  const [grantCursor, setGrantCursor] = useState<string>()
  const q = useQuery({
    queryKey: [...op.key, 'status'],
    queryFn: ({ signal }) => op.read(() => status(signal)),
  })
  const grants = useQuery({
    queryKey: [...op.key, 'grants', grantCursor],
    queryFn: ({ signal }) =>
      op.read(() => page('grants', grantSchema, signal, grantCursor)),
    enabled: q.isSuccess,
  })
  const apps = useQuery({
    queryKey: [...op.key, 'applications', cursor],
    queryFn: ({ signal }) =>
      op.read(() => page('applications', applicationSchema, signal, cursor)),
    enabled: q.data?.can_manage === true,
  })
  if (q.isPending)
    return <PageSkeleton label={copy('Loading MCP settings…', 'mcp')} />
  if (q.isError)
    return (
      <OperationsError
        error={q.error}
        retry={() => {
          void q.refetch()
        }}
      />
    )
  return (
    <section className="settings-section">
      <div>
        <p className="eyebrow">MCP</p>
        <h2 className="mt-2 text-lg font-semibold">
          {copy('AI connections', 'mcp')}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-muted">
          {copy(
            'Connect an assistant with your current permissions. Financial changes require a separate approval here.',
            'mcp',
          )}
        </p>
        <Link
          className="text-sm font-medium underline underline-offset-4 mt-3 inline-block"
          to="/app/mcp"
        >
          {copy('Connection guide', 'mcp')}
        </Link>
      </div>
      <div className="min-w-0 space-y-6">
        <TextField
          label={copy('MCP endpoint', 'mcp')}
          value={q.data.endpoint}
          readOnly
        />
        <p className="text-sm">
          {copy(q.data.enabled ? 'MCP is enabled' : 'MCP is disabled', 'mcp')}
        </p>
        {q.data.can_manage ? (
          <>
            <Button
              disabled={op.pending}
              onClick={() => {
                void op.run(() =>
                  authenticatedJSON('/api/v1/mcp/settings', {
                    method: 'PUT',
                    body: {
                      enabled: !q.data.enabled,
                      expected_revision: q.data.revision,
                    },
                  }),
                )
              }}
            >
              {copy(
                q.data.enabled ? 'Disable MCP and revoke grants' : 'Enable MCP',
                'mcp',
              )}
            </Button>
            <RegisterApplication />
          </>
        ) : null}
        <h3 className="font-semibold">{copy('Your access grants', 'mcp')}</h3>
        {grants.isError ? (
          <OperationsError
            error={grants.error}
            retry={() => {
              void grants.refetch()
            }}
          />
        ) : grants.isPending ? (
          <PageSkeleton label={copy('Loading MCP settings…', 'mcp')} />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {grants.data.data.map((g) => (
                <li key={g.id} className="space-y-2 py-4">
                  <p className="font-medium">{g.application_name}</p>
                  <p className="break-words text-xs text-muted">
                    {g.scopes
                      .split(' ')
                      .map((scope) => copy(scope, 'mcp'))
                      .join(' · ')}
                  </p>
                  <p className="text-xs">
                    {copy('Expires', 'mcp')}:{' '}
                    {formatDate(g.expires_at, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </p>
                  {g.revoked_at ? (
                    <p>{copy('Revoked', 'mcp')}</p>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={op.pending}
                      onClick={() => {
                        void op.run(() =>
                          authenticatedJSON(
                            `/api/v1/mcp/grants/${g.id}/revoke`,
                            { method: 'POST', body: {} },
                          ),
                        )
                      }}
                    >
                      {copy('Revoke access', 'mcp')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {!grants.data.data.length ? (
              <p>{copy('No authorized applications.', 'mcp')}</p>
            ) : null}
            <div className="flex gap-3">
              {grantCursor ? (
                <Button
                  variant="ghost"
                  onClick={() => setGrantCursor(undefined)}
                >
                  {copy('First page', 'mcp')}
                </Button>
              ) : null}
              {grants.data.page.next_cursor ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setGrantCursor(grants.data.page.next_cursor ?? undefined)
                  }
                >
                  {copy('Next page', 'mcp')}
                </Button>
              ) : null}
            </div>
          </>
        )}
        {q.data.can_manage ? (
          <>
            <h3 className="font-semibold">
              {copy('Registered applications', 'mcp')}
            </h3>
            {apps.isError ? (
              <OperationsError
                error={apps.error}
                retry={() => {
                  void apps.refetch()
                }}
              />
            ) : apps.data ? (
              <>
                <ul className="divide-y divide-line">
                  {apps.data.data.map((a) => (
                    <li key={a.id} className="space-y-2 py-4">
                      <p className="font-medium">{a.name}</p>
                      <TextField
                        label={copy('OAuth client ID', 'mcp')}
                        value={a.id}
                        readOnly
                      />
                      <p className="break-all text-xs text-muted">
                        {a.redirect_uris.join(' · ')}
                      </p>
                      {a.revoked_at ? (
                        <p>{copy('Revoked', 'mcp')}</p>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={op.pending}
                          onClick={() => {
                            void op.run(() =>
                              authenticatedJSON(
                                `/api/v1/mcp/applications/${a.id}/revoke`,
                                {
                                  method: 'POST',
                                  body: { expected_revision: a.revision },
                                },
                              ),
                            )
                          }}
                        >
                          {copy('Revoke application', 'mcp')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-3">
                  {cursor ? (
                    <Button
                      variant="ghost"
                      onClick={() => setCursor(undefined)}
                    >
                      {copy('First page', 'mcp')}
                    </Button>
                  ) : null}
                  {apps.data.page.next_cursor ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setCursor(apps.data.page.next_cursor ?? undefined)
                      }
                    >
                      {copy('Next page', 'mcp')}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        ) : null}
        {q.data.can_manage ? <MCPActivity /> : null}
        {op.error ? <p role="alert">{copy(op.error)}</p> : null}
      </div>
    </section>
  )
}
function RegisterApplication() {
  const op = useRecordOperations('mcp')
  const [name, setName] = useState('')
  const [redirect, setRedirect] = useState('')
  const [origin, setOrigin] = useState('')
  return (
    <form
      className="space-y-4 border-y border-line py-6"
      onSubmit={(e) => {
        e.preventDefault()
        void op
          .run(() =>
            authenticatedJSON('/api/v1/mcp/applications', {
              method: 'POST',
              body: {
                name,
                redirect_uris: redirect
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
                origins: origin
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            }),
          )
          .then((result) => {
            if (result) {
              setName('')
              setRedirect('')
              setOrigin('')
            }
          })
      }}
    >
      <h3 className="font-semibold">
        {copy('Register OAuth application', 'mcp')}
      </h3>
      <TextField
        label={copy('Application name', 'mcp')}
        value={name}
        maxLength={120}
        required
        onChange={(e) => setName(e.target.value)}
      />
      <label className="ui-field">
        <span className="ui-label">
          {copy('Exact redirect URLs, one per line', 'mcp')}
        </span>
        <textarea
          className="ui-input"
          value={redirect}
          maxLength={16384}
          required
          rows={3}
          onChange={(e) => setRedirect(e.target.value)}
        />
      </label>
      <label className="ui-field">
        <span className="ui-label">
          {copy('Browser origins, one per line (optional)', 'mcp')}
        </span>
        <textarea
          className="ui-input"
          value={origin}
          maxLength={2048}
          rows={2}
          onChange={(e) => setOrigin(e.target.value)}
        />
      </label>
      <p className="text-xs text-muted">
        {copy(
          'Only HTTPS or loopback HTTP callbacks are accepted. Registration does not grant access; each user must consent.',
          'mcp',
        )}
      </p>
      <Button type="submit" disabled={op.pending}>
        {copy('Register application', 'mcp')}
      </Button>
      {op.error ? <p role="alert">{copy(op.error)}</p> : null}
    </form>
  )
}
