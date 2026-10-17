import { useEffect, useState } from 'react'
import { formatDate } from '../../i18n/format'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import { Button, PageSkeleton, SelectField } from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsHeader, OperationsError } from '../operations/Shared'
import { authenticatedJSON, APIError } from '../../services/authenticated'
import { data, uuid } from '../operations/models'
import { z } from '../../lib/validation'
import { consentSchema, approvalSchema, status } from './service'
import { MCPSettings } from './MCPSettings'
export function MCPPage() {
  useLocale()
  const { authorizationID, approvalID } = useParams()
  const id = authorizationID ?? approvalID
  return (
    <section>
      <OperationsHeader
        title={copy(
          authorizationID
            ? 'Authorize AI connection'
            : approvalID
              ? 'Review requested change'
              : 'AI connections',
          'mcp',
        )}
      />
      {id ? <Review key={id} id={id} consent={!!authorizationID} /> : <Guide />}
    </section>
  )
}
function Guide() {
  const op = useRecordOperations('mcp')
  const [copied, setCopied] = useState(false)
  const q = useQuery({
    queryKey: [...op.key, 'status'],
    queryFn: ({ signal }) => op.read(() => status(signal)),
  })
  const config = q.data
    ? JSON.stringify(
        { mcpServers: { 'roisey-else': { url: q.data.endpoint } } },
        null,
        2,
      )
    : ''
  return (
    <>
      <div className="workspace-section space-y-4">
        <p>
          {copy(
            'Register the exact callback URLs supplied by your MCP client. Configure this endpoint, then sign in and choose the scopes and brand access you want to delegate.',
            'mcp',
          )}
        </p>
        <p>
          {copy(
            'Supported protocols: 2026-07-28 discovery and 2025-11-25 initialization. JSON responses only; no event subscriptions.',
            'mcp',
          )}
        </p>
        <p>
          {copy(
            'Authorization uses PKCE. Client secrets and personal access tokens are not required. Your assistant never receives your browser session.',
            'mcp',
          )}
        </p>
        {config ? (
          <>
            <pre className="overflow-x-auto rounded-md border border-line bg-surface p-4 text-xs">
              {config}
            </pre>
            <Button
              disabled={copied || !navigator.clipboard}
              onClick={() => {
                void navigator.clipboard.writeText(config).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }}
            >
              {copy(copied ? 'Copied' : 'Copy client configuration', 'mcp')}
            </Button>
          </>
        ) : null}
        <p>
          {copy(
            'If a change returns approval_required, open its review link in this panel. Approving does not execute the change; the assistant must repeat the exact command with the approval ID before it expires.',
            'mcp',
          )}
        </p>
        <a
          className="text-sm font-medium underline underline-offset-4"
          href="https://github.com/theroisey/else/blob/main/notes/mcp.md"
          target="_blank"
          rel="noreferrer"
        >
          {copy('Technical documentation', 'mcp')}
        </a>
      </div>
      <MCPSettings />
    </>
  )
}
function Review({ id, consent }: { id: string; consent: boolean }) {
  const op = useRecordOperations('mcp')
  const [clock, setClock] = useState(Date.now)
  const [selected, setSelected] = useState<string[] | null>(null)
  const [client, setClient] = useState('')
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState<string>()
  const [decided, setDecided] = useState(false)
  const kind = consent ? 'authorizations' : 'approvals'
  const valid = uuid.safeParse(id).success
  const q = useQuery({
    queryKey: [...op.key, kind, id],
    queryFn: ({ signal }) =>
      op.read(async () => {
        const raw = await authenticatedJSON(
          `/api/v1/mcp/${kind}/${uuid.parse(id)}`,
          { signal },
        )
        return consent ? data(consentSchema, raw) : data(approvalSchema, raw)
      }),
    enabled: valid,
    staleTime: 0,
  })
  const deadline = q.data?.expires_at
  useEffect(() => {
    if (!deadline) return
    const delay = Math.max(
      0,
      Math.min(2_147_483_647, Date.parse(deadline) - Date.now() + 1),
    )
    const timer = setTimeout(() => setClock(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [deadline])
  const brands = useQuery({
    queryKey: [...op.key, 'consent-brands', search, cursor],
    queryFn: ({ signal }) =>
      op.read(async () => {
        const query = new URLSearchParams({ limit: '25' })
        if (search) query.set('q', search)
        if (cursor) query.set('cursor', cursor)
        const raw = await authenticatedJSON(`/api/v1/clients?${query}`, {
          signal,
        })
        const parsed = z
          .object({
            data: z
              .array(
                z.object({ id: uuid, name: z.string().max(200) }).passthrough(),
              )
              .max(25),
            page: z
              .object({ limit: z.number(), next_cursor: uuid.nullable() })
              .strict(),
          })
          .strict()
          .safeParse(raw)
        if (!parsed.success) throw new APIError(0, 'invalid_response')
        return parsed.data
      }),
    enabled: valid && consent && q.isSuccess,
  })
  if (!valid)
    return (
      <p role="alert">
        {copy('This review link is invalid or no longer available.', 'mcp')}
      </p>
    )
  if (q.isPending)
    return <PageSkeleton label={copy('Loading review…', 'mcp')} />
  if (q.isError)
    return (
      <OperationsError
        error={q.error}
        retry={() => {
          void q.refetch()
        }}
      />
    )
  const pending = q.data
  const scopes = 'scopes' in pending ? (selected ?? pending.scopes) : []
  const expired = Date.parse(pending.expires_at) <= clock
  const approval = 'argument_digest' in pending ? pending : null
  async function decide(approve: boolean) {
    await op.run(async () => {
      const raw = await authenticatedJSON(`/api/v1/mcp/${kind}/${id}`, {
        method: 'POST',
        body: consent
          ? { approve, scopes, client_id: client || null }
          : { approve, argument_digest: approval?.argument_digest },
      })
      if (consent) {
        // The one-use code is never inserted into React/query state or persistence.
        const value = data(
          z.object({ redirect_url: z.string().url().max(4096) }).strict(),
          raw,
        )
        const target = new URL(value.redirect_url)
        const registered = new URL(
          'redirect_uri' in pending
            ? pending.redirect_uri
            : 'https://invalid.invalid/',
        )
        if (
          target.origin !== registered.origin ||
          target.pathname !== registered.pathname ||
          target.hash
        )
          throw new APIError(0, 'invalid_response')
        window.location.replace(target.href)
      } else {
        data(
          z
            .object({ id: uuid, state: z.enum(['approved', 'denied']) })
            .strict(),
          raw,
        )
        setDecided(true)
      }
    })
  }
  return (
    <div className="workspace-section max-w-3xl space-y-5">
      <p className="eyebrow">{pending.application_name}</p>
      <p>
        {copy('Expires', 'mcp')}:{' '}
        {formatDate(pending.expires_at, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
      </p>
      {consent && 'redirect_uri' in pending ? (
        <>
          <p className="break-all text-sm text-muted">
            {copy('Return address', 'mcp')}: {pending.redirect_uri}
          </p>
          <p>
            {copy(
              'Access can never exceed your current permissions. Revoke it at any time in Settings.',
              'mcp',
            )}
          </p>
          <fieldset disabled={op.pending || expired}>
            <legend className="mb-3 font-semibold">
              {copy('Requested scopes', 'mcp')}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {pending.scopes.map((scope) => (
                <label key={scope} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...scopes, scope]
                          : scopes.filter((s) => s !== scope),
                      )
                    }
                  />
                  <span>{copy(scope, 'mcp')}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="ui-field">
            <span className="ui-label">
              {copy('Find a brand (optional)', 'mcp')}
            </span>
            <input
              className="ui-input"
              value={search}
              maxLength={100}
              onChange={(e) => {
                setSearch(e.target.value)
                setCursor(undefined)
              }}
            />
          </label>
          <SelectField
            label={copy('Access boundary', 'mcp')}
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="">
              {copy('All records allowed by my permissions', 'mcp')}
            </option>
            {client && !brands.data?.data.some((b) => b.id === client) ? (
              <option value={client}>
                {copy('Previously selected brand', 'mcp')}
              </option>
            ) : null}
            {brands.data?.data.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
          {brands.data?.page.next_cursor ? (
            <Button
              variant="ghost"
              onClick={() =>
                setCursor(brands.data?.page.next_cursor ?? undefined)
              }
            >
              {copy('Next page', 'mcp')}
            </Button>
          ) : null}
        </>
      ) : approval ? (
        <>
          <p className="font-semibold break-words">{approval.tool_name}</p>
          <p>
            {copy(
              'Review the exact change below. Approval is limited to this application, your account, this command and this payload.',
              'mcp',
            )}
          </p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-4 text-xs">
            {JSON.stringify(approval.arguments, null, 2)}
          </pre>
          <p className="text-sm">
            {copy('Review state', 'mcp')}: {copy(approval.state, 'mcp')}
          </p>
        </>
      ) : null}
      {expired ? (
        <p role="status">
          {copy(
            'This review has expired. Ask the assistant to prepare a new review using the same command.',
            'mcp',
          )}
        </p>
      ) : decided ? (
        <p role="status">
          {copy(
            'Your decision is saved. Return to your assistant to continue.',
            'mcp',
          )}
        </p>
      ) : !approval || approval.state === 'pending' ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            disabled={op.pending || (consent && !scopes.length)}
            onClick={() => {
              void decide(true)
            }}
          >
            {copy(
              consent ? 'Authorize connection' : 'Approve exact change',
              'mcp',
            )}
          </Button>
          <Button
            variant="secondary"
            disabled={op.pending}
            onClick={() => {
              void decide(false)
            }}
          >
            {copy('Deny', 'mcp')}
          </Button>
        </div>
      ) : null}
      {op.error ? <p role="alert">{copy(op.error)}</p> : null}
      <Link
        className="text-sm font-medium underline underline-offset-4"
        to="/app/settings"
      >
        {copy('Back to settings', 'mcp')}
      </Link>
    </div>
  )
}
