import { hasPermission } from '../auth/permissions'
import { APIError } from '../../services/authenticated'
import { time } from './time'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { copy, useLocale } from '../../i18n'
import {
  Button,
  Dialog,
  SelectField,
  TextField,
  PageSkeleton,
} from '../../components/ui'
import { useRecordOperations } from '../auth/useRecordOperations'
import { OperationsHeader, OperationsError, RequestState } from './Shared'
import { actionLabels, eventLabels } from './models'
import type { RequestDetail } from './models'
import { EvidenceUpload } from './EvidenceUpload'
import * as api from './service'
export function RequestDetailPage() {
  useLocale()
  const { id = '', requestID = '' } = useParams()
  return <Detail key={id + requestID} client={id} id={requestID} />
}
function Detail({ client, id }: { client: string; id: string }) {
  useLocale()
  const op = useRecordOperations('operations', client)
  const [editing, setEditing] = useState<{
    action: string
    request: RequestDetail
  } | null>(null)
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')
  const history = useQuery({
    queryKey: [...op.key, 'deliveries', id, before],
    queryFn: ({ signal }) =>
      op.read(() => api.deliveries(client, id, before, signal)),
    enabled: !!before,
  })
  const query = useQuery({
    queryKey: [...op.key, 'request', id],
    queryFn: ({ signal }) => op.read(() => api.detail(client, id, signal)),
    refetchInterval: 30_000,
  })
  const timeline = useQuery({
    queryKey: [...op.key, 'timeline', id, after],
    queryFn: ({ signal }) =>
      op.read(() => api.timeline(client, id, after, signal)),
    enabled: query.isSuccess,
  })
  if (query.isPending)
    return <PageSkeleton label={copy('Loading request…', 'operations')} />
  if (query.isError)
    return (
      <OperationsError
        error={query.error}
        retry={() => {
          void query.refetch()
        }}
      />
    )
  const r = query.data
  const originals = r.evidence.filter((e) => e.delivery_id === null)
  const latest = r.deliveries[0]
  const image = (file: RequestDetail['evidence'][number]) => (
    <figure key={file.id} className="min-w-0">
      {file.mime.startsWith('image/') ? (
        <a
          href={api.evidenceURL(client, file.id)}
          target="_blank"
          rel="noreferrer"
        >
          <img
            src={api.evidenceURL(client, file.id)}
            alt={file.filename}
            className="max-h-80 w-full border border-line object-contain"
            loading="lazy"
          />
        </a>
      ) : (
        <a
          href={api.evidenceURL(client, file.id)}
          className="text-sm underline underline-offset-4"
        >
          {copy('Download document', 'operations')}
        </a>
      )}
      <figcaption className="mt-2 break-words text-xs text-muted">
        {file.filename} · {time(file.created_at)}
      </figcaption>
    </figure>
  )
  return (
    <section>
      <OperationsHeader title={r.title} client={client}>
        <Button
          onClick={() => {
            void query.refetch()
            void timeline.refetch()
          }}
          disabled={query.isFetching}
        >
          {copy('Refresh request', 'operations')}
        </Button>
      </OperationsHeader>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <RequestState status={r.status} />
          <p className="mt-3 break-words text-sm text-muted">
            {r.brand_name} ·{' '}
            {r.website_domain ?? copy('Brand-wide', 'operations')} ·{' '}
            {r.requester_name}
          </p>
        </div>
        <Link
          to={`/app/clients/${client}/requests`}
          className="text-sm underline underline-offset-4"
        >
          {copy('Back to requests', 'operations')}
        </Link>
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <section className="workspace-section">
            <h2 className="eyebrow">
              {copy('Original request', 'operations')}
            </h2>
            <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
              {r.description}
            </p>
            {r.reference_url ? (
              <a
                href={r.reference_url}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block break-all text-sm underline underline-offset-4"
              >
                {copy('Open reference page', 'operations')}
              </a>
            ) : null}
          </section>
          {originals.length || latest ? (
            <section className="workspace-section mt-8">
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <h2 className="mb-4 font-display text-2xl">
                    {copy('Before', 'operations')}
                  </h2>
                  <div className="grid gap-5">
                    {originals.map(image)}
                    {!originals.length ? (
                      <p className="text-sm text-muted">
                        {copy('No original screenshots.', 'operations')}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div>
                  <h2 className="mb-4 font-display text-2xl">
                    {copy('After', 'operations')}
                  </h2>
                  {latest ? (
                    <>
                      <p className="mb-4 whitespace-pre-wrap break-words text-sm leading-7">
                        {latest.summary}
                      </p>
                      <div className="grid gap-5">
                        {r.evidence
                          .filter((e) => e.delivery_id === latest.id)
                          .map(image)}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted">
                      {copy('No delivery has been submitted.', 'operations')}
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}
          <section className="workspace-section mt-8">
            <h2 className="font-display text-2xl">
              {copy('Delivery history', 'operations')}
            </h2>
            {before && history.isError ? (
              <OperationsError
                error={history.error}
                retry={() => {
                  void history.refetch()
                }}
              />
            ) : null}
            {before && history.isPending ? (
              <PageSkeleton label={copy('Loading request…', 'operations')} />
            ) : null}
            {(before ? (history.data?.data ?? []) : r.deliveries).map((d) => (
              <details
                key={d.id}
                className="border-b border-line py-4"
                open={d.id === latest?.id}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {copy('Delivery {{number}}', 'operations', {
                    number: d.number,
                  })}{' '}
                  · {d.developer_name} · {time(d.created_at)}
                </summary>
                <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7">
                  {d.summary}
                </p>
                {d.test_notes ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-muted">
                    {d.test_notes}
                  </p>
                ) : null}
                {d.implementation_url ? (
                  <a
                    href={d.implementation_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 block text-sm underline"
                  >
                    {copy('Open implemented change', 'operations')}
                  </a>
                ) : null}
                {d.reference ? (
                  <p className="mt-3 break-words text-xs text-muted">
                    {d.reference}
                  </p>
                ) : null}
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {r.evidence.filter((e) => e.delivery_id === d.id).map(image)}
                </div>
                {(before ? (history.data?.reviews ?? []) : r.reviews)
                  .filter((v) => v.delivery_id === d.id)
                  .map((v) => (
                    <div key={v.id} className="mt-5 border-l border-line pl-4">
                      <p className="text-sm font-medium">
                        {v.reviewer_name} ·{' '}
                        {copy(
                          v.decision === 'approved'
                            ? 'Approved'
                            : 'Revision requested',
                          'operations',
                        )}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm">
                        {v.reason}
                      </p>
                    </div>
                  ))}
              </details>
            ))}
          </section>
          <div className="my-5 flex flex-wrap gap-3">
            {before ? (
              <Button onClick={() => setBefore('')}>
                {copy('Latest deliveries', 'operations')}
              </Button>
            ) : null}
            {(!before &&
              r.deliveries.length === 25 &&
              r.deliveries.at(-1)!.number > 1) ||
            (before && history.data?.page.next_before) ? (
              <Button
                onClick={() =>
                  setBefore(
                    before
                      ? history.data!.page.next_before!
                      : String(r.deliveries.at(-1)!.number),
                  )
                }
              >
                {copy('Earlier deliveries', 'operations')}
              </Button>
            ) : null}
          </div>
          <section className="workspace-section mt-8">
            <h2 className="font-display text-2xl">
              {copy('Request timeline', 'operations')}
            </h2>
            {timeline.isPending ? (
              <PageSkeleton label={copy('Loading timeline…', 'operations')} />
            ) : timeline.isError ? (
              <OperationsError
                error={timeline.error}
                retry={() => {
                  void timeline.refetch()
                }}
              />
            ) : (
              <>
                <ol className="mt-5">
                  {timeline.data.data.map((e) => (
                    <li key={e.id} className="border-l border-line pb-6 pl-5">
                      <div className="flex flex-wrap justify-between gap-2">
                        <p className="text-sm font-medium">
                          {e.actor_name} ·{' '}
                          {copy(
                            eventLabels[e.action] ?? 'Operational update',
                            'operations',
                          )}
                        </p>
                        <time
                          dateTime={e.created_at}
                          className="text-xs text-muted"
                        >
                          {time(e.created_at)}
                        </time>
                      </div>
                      {e.text ? (
                        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
                          {e.text}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <div className="flex gap-3">
                  {after ? (
                    <Button onClick={() => setAfter('')}>
                      {copy('First events', 'operations')}
                    </Button>
                  ) : null}
                  {timeline.data.page.next_after ? (
                    <Button
                      onClick={() => setAfter(timeline.data!.page.next_after!)}
                    >
                      {copy('More events', 'operations')}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </section>
        </div>
        <aside className="context-rail">
          <h2 className="eyebrow">{copy('Next action', 'operations')}</h2>
          <div className="mt-5 flex flex-col gap-3">
            {r.actions.map((action) => (
              <Button
                key={action}
                variant={
                  ['accept', 'deliver', 'approve'].includes(action)
                    ? 'primary'
                    : 'secondary'
                }
                onClick={() => setEditing({ action, request: r })}
              >
                {copy(actionLabels[action], 'operations')}
              </Button>
            ))}
            {!r.actions.length ? (
              <p className="text-sm text-muted">
                {copy(
                  'No actions are available for your current access.',
                  'operations',
                )}
              </p>
            ) : null}
          </div>
          <dl className="mt-8 space-y-5 border-t border-line pt-5">
            <div>
              <dt className="eyebrow">
                {copy('Responsible developer', 'operations')}
              </dt>
              <dd className="mt-2 text-sm">
                {r.assignee_name ?? copy('Unassigned', 'operations')}
              </dd>
            </div>
            <div>
              <dt className="eyebrow">{copy('Due', 'operations')}</dt>
              <dd className="mt-2 text-sm">{time(r.due_at)}</dd>
            </div>
            <div>
              <dt className="eyebrow">{copy('Deliveries', 'operations')}</dt>
              <dd className="mt-2 text-sm tabular-nums">{r.delivery_count}</dd>
            </div>
          </dl>
          {r.task_id &&
          (hasPermission(op.auth.session?.user.permissions ?? [], {
            permission: 'tasks.view',
            scope: 'client',
            clientID: client,
          }) ||
            hasPermission(op.auth.session?.user.permissions ?? [], {
              permission: 'tasks.read_development',
              scope: 'client',
              clientID: client,
            }) ||
            (r.assignee_id === op.auth.session?.user.id &&
              hasPermission(op.auth.session?.user.permissions ?? [], {
                permission: 'tasks.read_own',
                scope: 'client',
                clientID: client,
              }))) ? (
            <Link
              className="mt-6 block text-xs underline underline-offset-4"
              to={`/app/clients/${client}/tasks/${r.task_id}`}
            >
              {copy('Linked development task', 'operations')}
            </Link>
          ) : null}
        </aside>
      </div>
      {editing ? (
        <ActionForm
          key={editing.action + editing.request.revision}
          client={client}
          action={editing.action}
          request={editing.request}
          current={r}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}
function ActionForm({
  client,
  action,
  request,
  current,
  onClose,
}: {
  client: string
  action: string
  request: RequestDetail
  current: RequestDetail
  onClose: () => void
}) {
  useLocale()
  const op = useRecordOperations('operations', client)
  const [reason, setReason] = useState('')
  const [assignee, setAssignee] = useState(
    request.assignee_id ?? op.auth.session?.user.id ?? '',
  )
  const [due, setDue] = useState(request.due_at ?? '')
  const [testNotes, setTestNotes] = useState('')
  const [url, setURL] = useState('')
  const [reference, setReference] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [command] = useState(() => crypto.randomUUID())
  const [sent, setSent] = useState<unknown>(null)
  const [cursor, setCursor] = useState('')
  const assignment = ['accept', 'assign'].includes(action)
  const candidates = useQuery({
    queryKey: [...op.key, 'developers', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.developers(client, cursor, signal)),
    enabled: assignment,
  })
  const stale = current.revision !== request.revision
  const available = current.actions.includes(
    action as RequestDetail['actions'][number],
  )
  const required = [
    'reject',
    'deliver',
    'revise',
    'comment',
    'reopen',
    'cancel',
  ].includes(action)
  return (
    <Dialog
      title={copy(actionLabels[action] ?? 'Request action', 'operations')}
      description={copy('Review the request before confirming.', 'operations')}
      open
      onClose={onClose}
      variant="drawer"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          if ((!sent && (stale || !available)) || uploading) return
          const body = sent ?? {
            command_id: command,
            expected_revision: request.revision,
            reason,
            assignee_id: assignment ? assignee || null : null,
            due_at: assignment ? due || null : null,
            delivery_id: ['approve', 'revise'].includes(action)
              ? request.deliveries[0]?.id
              : null,
            ...(action === 'deliver'
              ? {
                  test_notes: testNotes,
                  implementation_url: url,
                  reference,
                  evidence_ids: evidence,
                }
              : {}),
          }
          setSent(body)
          void op
            .run(
              () => api.act(client, request.id, action, body),
              (failure) => {
                if (failure instanceof APIError && failure.status === 400)
                  setSent(null)
              },
            )
            .then((v) => {
              if (v) onClose()
            })
        }}
      >
        {stale ? (
          <p role="alert" className="text-danger-ink">
            {copy(
              'This request changed. Close this form and review the latest state before acting.',
              'operations',
            )}
          </p>
        ) : null}
        <fieldset
          className="space-y-5"
          disabled={op.pending || uploading || !!sent || stale || !available}
        >
          {assignment ? (
            <>
              <SelectField
                label={copy('Responsible developer', 'operations')}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                required={action === 'assign'}
              >
                <option value="">{copy('Unassigned', 'operations')}</option>
                {candidates.data?.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name}
                  </option>
                ))}
                {assignee &&
                !candidates.data?.data.some((u) => u.id === assignee) ? (
                  <option value={assignee}>
                    {request.assignee_name ??
                      op.auth.session?.user.display_name}
                  </option>
                ) : null}
              </SelectField>
              {candidates.data?.page.next_cursor ? (
                <Button
                  size="compact"
                  onClick={() => setCursor(candidates.data!.page.next_cursor!)}
                >
                  {copy('More developers', 'operations')}
                </Button>
              ) : null}
              <TextField
                label={copy('Due at (UTC timestamp, optional)', 'operations')}
                value={due}
                onChange={(e) => setDue(e.target.value)}
                placeholder="2026-10-15T12:00:00Z"
              />
            </>
          ) : null}
          <div className="ui-field">
            <label className="ui-label" htmlFor="action-reason">
              {copy(
                action === 'deliver'
                  ? 'Completion summary'
                  : action === 'comment'
                    ? 'Comment'
                    : 'Explanation',
                'operations',
              )}
              {required ? ' *' : ''}
            </label>
            <textarea
              id="action-reason"
              className="ui-input min-h-32 w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={required}
              maxLength={8000}
            />
          </div>
          {action === 'deliver' ? (
            <details>
              <summary className="cursor-pointer text-sm">
                {copy('Test notes and references', 'operations')}
              </summary>
              <div className="mt-4 space-y-4">
                <TextField
                  label={copy('Implementation URL', 'operations')}
                  value={url}
                  type="url"
                  onChange={(e) => setURL(e.target.value)}
                  maxLength={2048}
                />
                <TextField
                  label={copy('Commit or work reference', 'operations')}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={300}
                />
                <TextField
                  label={copy('Test notes', 'operations')}
                  value={testNotes}
                  onChange={(e) => setTestNotes(e.target.value)}
                  maxLength={4000}
                />
              </div>
            </details>
          ) : null}
        </fieldset>
        {action === 'deliver' ? (
          <EvidenceUpload
            client={client}
            onChange={setEvidence}
            onBusy={setUploading}
            disabled={op.pending || !!sent || stale || !available}
          />
        ) : null}
        {op.error ? (
          <p role="alert" className="text-danger-ink">
            {copy(op.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button onClick={onClose} disabled={op.pending}>
            {copy('Close', 'common')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={op.pending}
            disabled={(!sent && (stale || !available)) || uploading}
          >
            {copy(
              sent ? 'Retry original submission' : actionLabels[action],
              'operations',
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
