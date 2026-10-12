import { useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  TextField,
  SelectField,
  PageSkeleton,
} from '../../components/ui'
import { statusLabel } from '../../i18n/labels'
import { copy, useLocale } from '../../i18n'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { AccessDenied } from '../clients/Shared'
import * as tasks from '../tasks/service'
import * as websites from '../websites/service'
import * as api from './recurring-service'
import type { Template } from './recurring-service'
import { OperationsHeader, OperationsError } from './Shared'
import { AutomationFailure, ManagerTransfer } from './AutomationControls'
import { businessSettings, localDate } from './preferences-service'
const t = (v: string) => copy(v, 'operations')
export function RecurringPage() {
  useLocale()
  const { id = '', templateID } = useParams()
  return templateID ? (
    <Detail key={id + templateID} client={id} id={templateID} />
  ) : (
    <List key={id} client={id} />
  )
}
function Pages({
  cursor,
  next,
  set,
}: {
  cursor: string
  next: string | null
  set: (v: string) => void
}) {
  return (
    <div className="mt-5 flex gap-3">
      {cursor ? (
        <Button onClick={() => set('')}>{t('First page')}</Button>
      ) : null}
      {next ? (
        <Button onClick={() => set(next)}>{t('Next page')}</Button>
      ) : null}
    </div>
  )
}
function List({ client }: { client: string }) {
  const op = useRecordOperations('recurring', client)
  const [cursor, setCursor] = useState('')
  const [form, setForm] = useState(false)
  const can = (key: string) =>
    hasPermission(op.auth.session?.user.permissions ?? [], {
      permission: key,
      scope: 'client',
      clientID: client,
    })
  const allowed = can('recurring.view') && can('clients.view')
  const q = useQuery({
    queryKey: [...op.key, 'list', cursor],
    queryFn: ({ signal }) => op.read(() => api.list(client, cursor, signal)),
    enabled: allowed,
  })
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <OperationsHeader title={t('Recurring tasks')} client={client}>
        {can('recurring.manage') ? (
          <Button variant="primary" onClick={() => setForm(true)}>
            {t('New recurring task')}
          </Button>
        ) : null}
      </OperationsHeader>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        {t(
          'Each scheduled occurrence becomes a separate task. Changing a template preserves previous work.',
        )}
      </p>
      {q.isPending ? (
        <PageSkeleton label={t('Loading recurring work…')} />
      ) : q.isError ? (
        <OperationsError
          error={q.error}
          retry={() => {
            void q.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {q.data.data.map((v) => (
              <li key={v.id} className="border-b border-line py-5">
                <Link
                  className="font-medium underline underline-offset-4"
                  to={`/app/clients/${client}/recurring-tasks/${v.id}`}
                >
                  {v.title}
                </Link>
                <p className="mt-2 text-sm text-muted">
                  {v.assignee_name} · {t(v.frequency)} · {t(v.status)} ·{' '}
                  {t('Next occurrence')}: {v.next_date}
                </p>
              </li>
            ))}
          </ul>
          {!q.data.data.length ? (
            <p className="py-5 text-muted">
              {t('No recurring tasks configured.')}
            </p>
          ) : null}
          <Pages
            cursor={cursor}
            next={q.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
      {form ? (
        <TemplateForm client={client} close={() => setForm(false)} />
      ) : null}
    </section>
  )
}
function Detail({ client, id }: { client: string; id: string }) {
  const op = useRecordOperations('recurring', client)
  const [cursor, setCursor] = useState('')
  const [edit, setEdit] = useState(false)
  const [transfer, setTransfer] = useState(false)
  const [history, setHistory] = useState(false)
  const [versionCursor, setVersionCursor] = useState('')
  const q = useQuery({
    queryKey: [...op.key, 'detail', id],
    queryFn: ({ signal }) => op.read(() => api.read(client, id, signal)),
    refetchInterval: 30000,
  })
  const occurrences = useQuery({
    queryKey: [...op.key, 'occurrences', id, cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.occurrences(client, id, cursor, signal)),
    enabled: q.isSuccess,
  })
  const versions = useQuery({
    queryKey: [...op.key, 'versions', id, versionCursor],
    queryFn: ({ signal }) =>
      op.read(() => api.versions(client, id, versionCursor, signal)),
    enabled: q.isSuccess && history,
  })
  const can = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'recurring.manage',
    scope: 'client',
    clientID: client,
  })
  const sent = useRef<unknown>(null)
  if (q.isPending) return <PageSkeleton label={t('Loading recurring work…')} />
  if (q.isError)
    return (
      <OperationsError
        error={q.error}
        retry={() => {
          void q.refetch()
        }}
      />
    )
  const v = q.data
  const act = (status: string) => {
    const body = sent.current ?? {
      command_id: crypto.randomUUID(),
      expected_revision: v.revision,
      status,
    }
    sent.current = body
    void op
      .run(() => api.write(client, id, body))
      .then((r) => {
        if (r) sent.current = null
      })
  }
  return (
    <section>
      <OperationsHeader title={v.title} client={client}>
        <Link to={`/app/clients/${client}/recurring-tasks`}>
          {t('Back to recurring tasks')}
        </Link>
      </OperationsHeader>
      <p className="whitespace-pre-wrap break-words text-sm">{v.description}</p>
      <dl className="mt-6 grid gap-5 border-y border-line py-6 sm:grid-cols-3">
        {[
          ['Assignee', v.assignee_name],
          ['Frequency', `${t(v.frequency)} · ${v.interval}`],
          ['Next occurrence', v.next_date],
          ['Timezone', v.timezone],
          ['Due time', v.due_time],
          ['Status', t(v.status)],
          ['Generated occurrences', v.generated_count],
          ['Responsible manager', v.manager_name],
          ['Website', v.website_name ?? t('Brand-wide work')],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{t(label!)}</dt>
            <dd className="mt-2 text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      <AutomationFailure failure={v.automation_failure} />
      {can && ['active', 'paused'].includes(v.status) ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <Button disabled={op.pending} onClick={() => setTransfer(true)}>
            {t('Transfer automation responsibility')}
          </Button>
          <Button disabled={op.pending} onClick={() => setEdit(true)}>
            {t('Edit future schedule')}
          </Button>
          <Button
            disabled={op.pending}
            onClick={() => act(v.status === 'active' ? 'paused' : 'active')}
          >
            {t(v.status === 'active' ? 'Pause schedule' : 'Resume schedule')}
          </Button>
          <Button
            variant="danger-ghost"
            disabled={op.pending}
            onClick={() => {
              if (
                window.confirm(
                  t('Stop future occurrences? Historical tasks remain.'),
                )
              )
                act('cancelled')
            }}
          >
            {t('Stop schedule')}
          </Button>
          {v.status === 'active' ? (
            <Button
              disabled={op.pending}
              onClick={() => {
                void op.run(() =>
                  api.write(client, id, { scheduled_date: v.next_date }, true),
                )
              }}
            >
              {t('Generate due occurrence')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {op.error ? (
        <p role="alert" className="mt-4 text-danger-ink">
          {copy(op.error)}
        </p>
      ) : null}
      <details
        className="mt-8"
        onToggle={(e) => setHistory(e.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm">
          {t('Schedule history')}
        </summary>
        {history ? (
          versions.isPending ? (
            <PageSkeleton label={t('Loading recurring work…')} />
          ) : versions.isError ? (
            <OperationsError
              error={versions.error}
              retry={() => {
                void versions.refetch()
              }}
            />
          ) : (
            <>
              <ul>
                {versions.data.data.map((row) => (
                  <li
                    key={row.id}
                    className="border-b border-line py-4 text-sm"
                  >
                    <p className="font-medium">
                      {row.title} · {t('Version')} {row.number}
                    </p>
                    <p className="mt-2 text-muted">
                      {row.assignee_name} · {t(row.frequency)} · {row.interval}{' '}
                      · {row.start_date} · {row.due_time} {row.timezone}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap">
                      {row.description}
                    </p>
                  </li>
                ))}
              </ul>
              <Pages
                cursor={versionCursor}
                next={versions.data.page.next_cursor}
                set={setVersionCursor}
              />
            </>
          )
        ) : null}
      </details>
      <h2 className="section-heading mt-10">{t('Generated tasks')}</h2>
      {occurrences.isPending ? (
        <PageSkeleton label={t('Loading recurring work…')} />
      ) : occurrences.isError ? (
        <OperationsError
          error={occurrences.error}
          retry={() => {
            void occurrences.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {occurrences.data.data.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap justify-between gap-3 border-b border-line py-5"
              >
                <Link
                  className="underline underline-offset-4"
                  to={`/app/clients/${client}/tasks/${o.task_id}`}
                >
                  {o.title}
                </Link>
                <p className="text-sm text-muted">
                  {o.scheduled_date} · {o.assignee_name ?? t('Unassigned')} ·{' '}
                  {statusLabel(o.status)}
                </p>
              </li>
            ))}
          </ul>
          {!occurrences.data.data.length ? (
            <p className="py-5 text-muted">
              {t('No occurrences generated yet.')}
            </p>
          ) : null}
          <Pages
            cursor={cursor}
            next={occurrences.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
      {transfer ? (
        <ManagerTransfer
          client={client}
          id={id}
          revision={v.revision}
          current={v.managed_by}
          financial={false}
          close={() => setTransfer(false)}
        />
      ) : null}
      {edit ? (
        <TemplateForm
          client={client}
          initial={v}
          close={() => setEdit(false)}
        />
      ) : null}
    </section>
  )
}
function TemplateForm(props: {
  client: string
  initial?: Template
  close: () => void
}) {
  const op = useRecordOperations('recurring', props.client)
  const q = useQuery({
    queryKey: [...op.key, 'business-settings'],
    queryFn: ({ signal }) => op.read(() => businessSettings(signal)),
    enabled: !props.initial,
  })
  if (props.initial)
    return <TemplateEditor {...props} defaultZone={props.initial.timezone} />
  if (q.isPending || q.isError)
    return (
      <Dialog
        open
        variant="drawer"
        title={t('New recurring task')}
        description={t('Loading recurring work…')}
        onClose={props.close}
      >
        {q.isPending ? (
          <PageSkeleton label={t('Loading recurring work…')} />
        ) : (
          <OperationsError
            error={q.error}
            retry={() => {
              void q.refetch()
            }}
          />
        )}
      </Dialog>
    )
  return <TemplateEditor {...props} defaultZone={q.data.timezone} />
}
function TemplateEditor({
  client,
  initial,
  close,
  defaultZone,
}: {
  client: string
  initial?: Template
  close: () => void
  defaultZone: string
}) {
  const [baseline] = useState(initial)
  const op = useRecordOperations('recurring', client)
  const navigate = useNavigate()
  const [title, setTitle] = useState(baseline?.title ?? '')
  const [description, setDescription] = useState(baseline?.description ?? '')
  const [priority, setPriority] = useState(baseline?.priority ?? 'medium')
  const [supervisor, setSupervisor] = useState(baseline?.supervisor_id ?? '')
  const [supervisorCursor, setSupervisorCursor] = useState('')
  const [assignee, setAssignee] = useState(baseline?.assignee_id ?? '')
  const [website, setWebsite] = useState(baseline?.website_id ?? '')
  const [frequency, setFrequency] = useState(baseline?.frequency ?? 'daily')
  const [interval, setInterval] = useState(String(baseline?.interval ?? 1))
  const [start, setStart] = useState(() => localDate(defaultZone, !!baseline))
  const [end, setEnd] = useState(baseline?.end_date ?? '')
  const [due, setDue] = useState(baseline?.due_time ?? '17:00')
  const [zone, setZone] = useState(baseline?.timezone ?? defaultZone)
  const [limit, setLimit] = useState(
    baseline?.occurrence_limit ? String(baseline.occurrence_limit) : '',
  )
  const [cursor, setCursor] = useState('')
  const [siteCursor, setSiteCursor] = useState('')
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState('')
  const command = useRef(crypto.randomUUID())
  const sent = useRef<unknown>(null)
  const candidates = useQuery({
    queryKey: [...op.key, 'assignees', cursor],
    queryFn: ({ signal }) =>
      op.read(() => tasks.candidates(client, cursor, signal)),
  })
  const supervisors = useQuery({
    queryKey: [...op.key, 'supervisors', assignee, supervisorCursor],
    enabled: !!assignee,
    queryFn: ({ signal }) =>
      op.read(() =>
        api.supervisors(client, assignee, supervisorCursor, signal),
      ),
  })
  const sites = useQuery({
    queryKey: [...op.key, 'websites', siteCursor],
    queryFn: ({ signal }) =>
      op.read(() => websites.list(client, siteCursor, 'active', signal)),
  })
  return (
    <Dialog
      open
      variant="drawer"
      title={t(baseline ? 'Edit future schedule' : 'New recurring task')}
      description={t(
        'Choose the first local date. Weekly schedules repeat that weekday; monthly schedules retain the original calendar-day anchor.',
      )}
      onClose={() => {
        if (
          !op.pending &&
          (!locked ||
            window.confirm(
              t(
                'Close this form and inspect the recorded history before starting another transaction?',
              ),
            ))
        )
          close()
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          setError('')
          if (!sent.current) {
            if (!assignee || !title.trim()) {
              setError(t('Choose an assignee and enter a task title.'))
              return
            }
            const profile = {
              title,
              description,
              priority,
              assignee_id: assignee,
              website_id: website || null,
              supervisor_id: supervisor || null,
              start_date: start,
              end_date: end || null,
              frequency,
              interval: Number(interval),
              due_time: due,
              timezone: zone,
              occurrence_limit: limit ? Number(limit) : null,
            }
            sent.current = baseline
              ? {
                  command_id: command.current,
                  expected_revision: baseline.revision,
                  profile,
                }
              : { command_id: command.current, profile }
            setLocked(true)
          }
          void op
            .run(
              () => api.write(client, baseline?.id, sent.current),
              (failure) => {
                if (failure instanceof APIError && failure.status === 400) {
                  sent.current = null
                  setLocked(false)
                }
              },
            )
            .then((r) => {
              if (r) {
                close()
                if (!baseline)
                  navigate(`/app/clients/${client}/recurring-tasks/${r.id}`)
              }
            })
        }}
      >
        <fieldset className="space-y-5" disabled={op.pending || locked}>
          <TextField
            required
            label={t('Task title')}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <SelectField
            required
            label={t('Assignee')}
            value={assignee}
            onChange={(e) => {
              setAssignee(e.target.value)
              setSupervisor('')
              setSupervisorCursor('')
            }}
          >
            <option value="">{t('Choose an assignee')}</option>
            {assignee &&
            !candidates.data?.data.some((v) => v.id === assignee) ? (
              <option value={assignee}>
                {baseline?.assignee_name ?? t('Selected assignee')}
              </option>
            ) : null}
            {candidates.data?.data.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name}
              </option>
            ))}
          </SelectField>
          {candidates.isError ? (
            <OperationsError
              error={candidates.error}
              retry={() => {
                void candidates.refetch()
              }}
            />
          ) : null}
          <Pages
            cursor={cursor}
            next={candidates.data?.page.next_cursor ?? null}
            set={setCursor}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t('Frequency')}
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as Template['frequency'])
              }
            >
              {['daily', 'weekly', 'monthly'].map((v) => (
                <option key={v} value={v}>
                  {t(v)}
                </option>
              ))}
            </SelectField>
            <TextField
              required
              label={t('Repeat every')}
              type="number"
              min="1"
              max="365"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            />
            <TextField
              required
              label={t(baseline ? 'Future start date' : 'Start date')}
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <TextField
              required
              label={t('Due time')}
              type="time"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
          <details>
            <summary className="cursor-pointer text-sm">
              {t('Optional details')}
            </summary>
            <div className="mt-4 space-y-4">
              <TextField
                label={t('Description')}
                maxLength={8000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <SelectField
                label={t('Priority')}
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as Template['priority'])
                }
              >
                {['low', 'medium', 'high', 'urgent'].map((v) => (
                  <option key={v} value={v}>
                    {statusLabel(v)}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={t('Website')}
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              >
                <option value="">{t('Brand-wide work')}</option>
                {website && !sites.data?.data.some((v) => v.id === website) ? (
                  <option value={website}>
                    {baseline?.website_name ?? t('Selected website')}
                  </option>
                ) : null}
                {sites.data?.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.domain}
                  </option>
                ))}
              </SelectField>
              {sites.isError ? (
                <OperationsError
                  error={sites.error}
                  retry={() => {
                    void sites.refetch()
                  }}
                />
              ) : null}
              <Pages
                cursor={siteCursor}
                next={sites.data?.page.next_cursor ?? null}
                set={setSiteCursor}
              />
              <SelectField
                label={t('Supervising leader')}
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
              >
                <option value="">{t('No supervising leader')}</option>
                {supervisor &&
                !supervisors.data?.data.some((v) => v.id === supervisor) ? (
                  <option value={supervisor}>
                    {baseline?.supervisor_name ?? t('Selected manager')}
                  </option>
                ) : null}
                {supervisors.data?.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.display_name}
                  </option>
                ))}
              </SelectField>
              {supervisors.isError ? (
                <OperationsError
                  error={supervisors.error}
                  retry={() => {
                    void supervisors.refetch()
                  }}
                />
              ) : null}
              <Pages
                cursor={supervisorCursor}
                next={supervisors.data?.page.next_cursor ?? null}
                set={setSupervisorCursor}
              />
              <TextField
                label={t('Timezone')}
                required
                maxLength={100}
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              />
              <TextField
                label={t('End date')}
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
              <TextField
                label={t('Total occurrence limit')}
                type="number"
                min="1"
                max="100000"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </div>
          </details>
        </fieldset>
        {error || op.error ? (
          <p role="alert" className="text-danger-ink">
            {error || copy(op.error)}
          </p>
        ) : null}
        {locked ? (
          <p className="text-sm text-muted">
            {t(
              'Values are held for reconciliation. Retry sends the original command only.',
            )}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={op.pending}>
          {t(locked ? 'Retry original command' : 'Save')}
        </Button>
      </form>
    </Dialog>
  )
}
