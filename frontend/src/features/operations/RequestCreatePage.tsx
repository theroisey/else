import { APIError } from '../../services/authenticated'
import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import { Button, SelectField, TextField } from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { AccessDenied } from '../clients/Shared'
import * as clients from '../clients/service'
import * as websites from '../websites/service'
import { OperationsHeader, OperationsError } from './Shared'
import { EvidenceUpload } from './EvidenceUpload'
import * as api from './service'
export function RequestCreatePage() {
  useLocale()
  const { id = '', websiteID = '' } = useParams()
  return (
    <Create key={id + websiteID} initialClient={id} initialSite={websiteID} />
  )
}
function Create({
  initialClient,
  initialSite,
}: {
  initialClient: string
  initialSite: string
}) {
  useLocale()
  const op = useRecordOperations('operations')
  const navigate = useNavigate()
  const grants = op.auth.session?.user.permissions ?? []
  const [client, setClient] = useState(initialClient)
  const [site, setSite] = useState(initialSite)
  const [brandCursor, setBrandCursor] = useState('')
  const [siteCursor, setSiteCursor] = useState('')
  const [search, setSearch] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('bug')
  const [priority, setPriority] = useState('normal')
  const [reference, setReference] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const command = useRef(crypto.randomUUID())
  const sent = useRef<unknown>(null)
  const brandQuery = useQuery({
    queryKey: [...op.key, 'creation-brands', search, brandCursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        clients.clients(
          { q: search, tag: '', status: 'active', sort: 'id' },
          brandCursor,
          signal,
        ),
      ),
  })
  const siteQuery = useQuery({
    queryKey: [...op.key, 'creation-sites', client, siteCursor],
    queryFn: ({ signal }) =>
      op.read(() => websites.list(client, siteCursor, 'active', signal)),
    enabled: !!client,
  })
  const allowed = client
    ? hasPermission(grants, {
        permission: 'tickets.create',
        scope: 'client',
        clientID: client,
      }) &&
      hasPermission(grants, {
        permission: 'clients.view',
        scope: 'client',
        clientID: client,
      })
    : grants.some((g) => g.permission === 'tickets.create')
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <OperationsHeader
        title={copy('New technical request', 'operations')}
        client={initialClient || undefined}
      />
      <form
        className="max-w-3xl space-y-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (
            uploading ||
            !client ||
            !site ||
            !title.trim() ||
            !description.trim()
          )
            return
          setAttempted(true)
          const body = sent.current ?? {
            command_id: command.current,
            website_id: site === 'brand' ? null : site,
            brand_wide: site === 'brand',
            title: title.trim(),
            description: description.trim(),
            category,
            priority,
            reference_url: reference.trim(),
            evidence_ids: evidence,
          }
          sent.current = body
          void op
            .run(
              () => api.create(client, body),
              (failure) => {
                if (failure instanceof APIError && failure.status === 400) {
                  sent.current = null
                  setAttempted(false)
                }
              },
            )
            .then((result) => {
              if (result)
                navigate(`/app/clients/${client}/requests/${result.id}`, {
                  replace: true,
                })
            })
        }}
      >
        <fieldset
          className="space-y-6"
          disabled={op.pending || uploading || attempted}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              {!initialClient ? (
                <TextField
                  label={copy('Find brand', 'operations')}
                  value={search}
                  maxLength={100}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setBrandCursor('')
                  }}
                />
              ) : null}
              <SelectField
                label={copy('Brand', 'operations')}
                required
                value={client}
                disabled={!!initialClient}
                onChange={(e) => {
                  setClient(e.target.value)
                  setSite('')
                  setSiteCursor('')
                  setEvidence([])
                }}
              >
                <option value="">{copy('Choose a brand', 'operations')}</option>
                {brandQuery.data?.data
                  .filter((b) =>
                    hasPermission(grants, {
                      permission: 'tickets.create',
                      scope: 'client',
                      clientID: b.id,
                    }),
                  )
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                {client &&
                !brandQuery.data?.data.some((b) => b.id === client) ? (
                  <option value={client}>
                    {copy('Selected brand', 'operations')}
                  </option>
                ) : null}
              </SelectField>
              {brandQuery.data?.page.next_cursor ? (
                <Button
                  size="compact"
                  onClick={() =>
                    setBrandCursor(brandQuery.data!.page.next_cursor!)
                  }
                >
                  {copy('More brands', 'operations')}
                </Button>
              ) : null}
              {brandQuery.isError ? (
                <OperationsError
                  error={brandQuery.error}
                  retry={() => {
                    void brandQuery.refetch()
                  }}
                />
              ) : null}
            </div>
            <div>
              <SelectField
                label={copy('Website or brand-wide work', 'operations')}
                required
                value={site}
                disabled={!client}
                onChange={(e) => setSite(e.target.value)}
              >
                <option value="">
                  {copy('Choose the affected website', 'operations')}
                </option>
                <option value="brand">
                  {copy('Brand-wide', 'operations')}
                </option>
                {siteQuery.data?.data
                  .filter((w) => !w.needs_review)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.domain}
                    </option>
                  ))}
                {site &&
                site !== 'brand' &&
                !siteQuery.data?.data.some((w) => w.id === site) ? (
                  <option value={site}>
                    {copy('Selected website', 'operations')}
                  </option>
                ) : null}
              </SelectField>
              {siteQuery.data?.page.next_cursor ? (
                <Button
                  size="compact"
                  onClick={() =>
                    setSiteCursor(siteQuery.data!.page.next_cursor!)
                  }
                >
                  {copy('More websites', 'operations')}
                </Button>
              ) : null}
              {siteQuery.isError ? (
                <OperationsError
                  error={siteQuery.error}
                  retry={() => {
                    void siteQuery.refetch()
                  }}
                />
              ) : null}
            </div>
          </div>
          <TextField
            label={copy('Request title', 'operations')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
          />
          <div className="ui-field">
            <label className="ui-label" htmlFor="request-description">
              {copy('What needs to change?', 'operations')}
            </label>
            <textarea
              id="request-description"
              className="ui-input min-h-36 w-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={8000}
              required
            />
            <p className="text-xs text-muted">
              {copy(
                'Describe what happens and what you expected. Technical terminology is optional.',
                'operations',
              )}
            </p>
          </div>
          <details className="border-t border-line py-4">
            <summary className="cursor-pointer text-sm font-medium">
              {copy('Additional details', 'operations')}
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SelectField
                label={copy('Category', 'operations')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {[
                  ['bug', 'Bug'],
                  ['design', 'Design'],
                  ['feature', 'New feature'],
                  ['content', 'Content / image'],
                  ['performance', 'Performance'],
                  ['integration', 'Integration'],
                  ['support', 'Technical support'],
                  ['other', 'Other'],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {copy(label, 'operations')}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={copy('Priority', 'operations')}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {[
                  ['normal', 'Normal priority'],
                  ['high', 'High priority'],
                  ['critical', 'Critical'],
                ].map(([v, label]) => (
                  <option key={v} value={v}>
                    {copy(label, 'operations')}
                  </option>
                ))}
              </SelectField>
              <TextField
                label={copy('Reference URL', 'operations')}
                type="url"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={2048}
              />
            </div>
          </details>
        </fieldset>
        {client ? (
          <EvidenceUpload
            key={client}
            client={client}
            onChange={setEvidence}
            onBusy={setUploading}
            disabled={op.pending || attempted}
          />
        ) : null}
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        {attempted && op.error ? (
          <p className="text-xs leading-6 text-muted">
            {copy(
              'The original submission is retained. Retry sends the same command; do not create another request until its outcome is known.',
              'operations',
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="primary"
            loading={op.pending}
            disabled={uploading || !client || !site}
          >
            {copy(
              attempted ? 'Retry original submission' : 'Submit request',
              'operations',
            )}
          </Button>
          <Button
            disabled={op.pending}
            onClick={() =>
              navigate(
                initialClient
                  ? `/app/clients/${initialClient}/requests`
                  : '/app/requests',
              )
            }
          >
            {copy('Back to requests', 'operations')}
          </Button>
        </div>
      </form>
    </section>
  )
}
