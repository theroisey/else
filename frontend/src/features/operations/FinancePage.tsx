import { MaskedReference } from './MaskedReference'
import { RefundForm } from './RefundForm'
import { VoidPeriod } from './VoidPeriod'
import { PeriodFiltersPanel } from './PeriodFiltersPanel'
import { AutomationFailure, ManagerTransfer } from './AutomationControls'
import { useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  SelectField,
  Table,
  TextField,
  PageSkeleton,
} from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { APIError } from '../../services/authenticated'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { AccessDenied } from '../clients/Shared'
import * as clients from '../clients/service'
import * as billing from '../billing/service'
import { money, toMinor, decimal, exponents } from '../billing/money'
import type { Currency } from '../billing/money'
import { currencies } from '../billing/models'
import * as api from './commercial-service'
import type { Agreement, Period } from './commercial-service'
import { OperationsHeader, OperationsError } from './Shared'
import { businessSettings, localDate } from './preferences-service'
const t = (v: string) => copy(v, 'operations')
export function FinancePage() {
  useLocale()
  const { id = '', periodID } = useParams()
  return id ? (
    periodID ? (
      <PeriodDetail key={id + periodID} client={id} id={periodID} />
    ) : (
      <BrandFinance key={id} client={id} />
    )
  ) : (
    <FinanceBrands />
  )
}
function FinanceBrands() {
  const op = useRecordOperations('agreements')
  const allowed = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'finance.read_company',
    scope: 'global',
  })
  const [cursor, setCursor] = useState('')
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const q = useQuery({
    enabled: allowed,
    queryKey: [...op.key, 'brands', cursor, search],
    queryFn: ({ signal }) =>
      op.read(() =>
        clients.clients(
          { q: search, status: 'all', tag: '', sort: 'id' },
          cursor,
          signal,
        ),
      ),
  })
  const grants = op.auth.session?.user.permissions ?? []
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <OperationsHeader title={t('Finance')}>
        <Link className="underline text-sm" to="/app/finance/dashboard">
          {copy('Financial Dashboard', 'finance')}
        </Link>
      </OperationsHeader>
      <TextField
        label={t('Find brand')}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setCursor('')
        }}
      />
      {q.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : q.isError ? (
        <OperationsError
          error={q.error}
          retry={() => {
            void q.refetch()
          }}
        />
      ) : (
        <>
          <ul className="mt-5">
            {q.data.data
              .filter(
                (b) =>
                  hasPermission(grants, {
                    permission: 'agreements.view',
                    scope: 'client',
                    clientID: b.id,
                  }) &&
                  hasPermission(grants, {
                    permission: 'billing.view',
                    scope: 'client',
                    clientID: b.id,
                  }),
              )
              .map((b) => (
                <li key={b.id} className="border-b border-line py-4">
                  <Button
                    variant="text"
                    onClick={() => navigate(`/app/clients/${b.id}/finance`)}
                  >
                    {b.name}
                  </Button>
                </li>
              ))}
          </ul>
          <Pages
            cursor={cursor}
            next={q.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
    </section>
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
function BrandFinance({ client }: { client: string }) {
  const op = useRecordOperations('agreements', client)
  const [cursor, setCursor] = useState('')
  const [periodCursor, setPeriodCursor] = useState('')
  const [periodFilters, setPeriodFilters] = useState<api.PeriodFilters>({
    q: '',
    service_type: '',
    currency: '',
    collector: '',
    partner_id: '',
    payment_status: '',
    from: '',
    to: '',
  })
  const [form, setForm] = useState<'create' | 'partner' | null>(null)
  const [selected, setSelected] = useState<Agreement | null>(null)
  const grants = op.auth.session?.user.permissions ?? []
  const can = (permission: string) =>
    hasPermission(grants, { permission, scope: 'client', clientID: client })
  const allowed = can('agreements.view') && can('billing.view')
  const manage = can('agreements.manage')
  const q = useQuery({
    queryKey: [...op.key, 'list', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.agreements(client, cursor, signal)),
    enabled: allowed,
  })
  const periods = useQuery({
    queryKey: [...op.key, 'periods', periodCursor, periodFilters],
    queryFn: ({ signal }) =>
      op.read(() =>
        api.periods(client, null, periodCursor, signal, periodFilters),
      ),
    enabled: allowed,
  })
  const totals = useQuery({
    queryKey: [...op.key, 'receivables'],
    queryFn: ({ signal }) => op.read(() => billing.summary(client, signal)),
    enabled: allowed,
  })
  if (!allowed) return <AccessDenied />
  return (
    <section>
      <OperationsHeader title={t('Service finance')} client={client}>
        {manage ? (
          <Button variant="primary" onClick={() => setForm('create')}>
            {t('New service agreement')}
          </Button>
        ) : null}
      </OperationsHeader>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        {t(
          'Customer charges, actual payments and internal partner transfers are recorded separately. Currency balances remain separate.',
        )}
      </p>
      {totals.data ? (
        <div className="mb-8 grid gap-6 border-y border-line py-5 sm:grid-cols-2">
          {totals.data.map((v) => (
            <div key={v.currency}>
              <p className="text-sm text-muted">
                {t('Customer outstanding')} · {v.currency}
              </p>
              <p className="mt-2 font-display text-3xl tabular-nums">
                {money(v.outstanding_minor, v.currency)}
              </p>
            </div>
          ))}
        </div>
      ) : totals.isError ? (
        <OperationsError
          error={totals.error}
          retry={() => {
            void totals.refetch()
          }}
        />
      ) : null}
      <h2 className="section-heading">{t('Service agreements')}</h2>
      {q.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
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
            {q.data.data.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4"
              >
                <div>
                  <p className="font-medium">{a.title}</p>
                  <p className="mt-1 text-sm text-muted">
                    {t(a.status)} · {t(a.frequency)} · {t('Next period')}:{' '}
                    {a.next_date}
                  </p>
                </div>
                <Button onClick={() => setSelected(a)}>
                  {t('Agreement details')}
                </Button>
              </li>
            ))}
          </ul>
          {!q.data.data.length ? (
            <p className="py-5 text-muted">
              {t('No service agreements recorded.')}
            </p>
          ) : null}
          <Pages
            cursor={cursor}
            next={q.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
      {manage &&
      hasPermission(grants, {
        permission: 'finance.read_company',
        scope: 'global',
      }) ? (
        <Button
          className="mt-4"
          variant="text"
          onClick={() => setForm('partner')}
        >
          {t('Add advertising partner')}
        </Button>
      ) : null}
      <h2 className="section-heading mt-10">{t('Billing periods')}</h2>
      <PeriodFiltersPanel
        client={client}
        value={periodFilters}
        onApply={(filters) => {
          setPeriodCursor('')
          setPeriodFilters(filters)
        }}
      />
      {periods.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : periods.isError ? (
        <OperationsError
          error={periods.error}
          retry={() => {
            void periods.refetch()
          }}
        />
      ) : (
        <>
          <Table
            caption={t('Billing periods')}
            className="w-full min-w-[48rem]"
          >
            <thead>
              <tr>
                {[
                  'Service',
                  'Period',
                  'Contracted',
                  'Collected',
                  'Customer outstanding',
                  'Internal balance',
                ].map((v, index) => (
                  <th
                    key={v}
                    scope="col"
                    className={index >= 2 && index <= 4 ? 'numeric' : undefined}
                  >
                    {t(v)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.data.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link
                      className="underline underline-offset-4"
                      to={`/app/clients/${client}/finance/${p.id}`}
                    >
                      {p.title}
                    </Link>
                  </td>
                  <td>{p.period_key}</td>
                  <td className="numeric whitespace-nowrap">
                    {money(p.amount_minor, p.currency)}
                  </td>
                  <td className="numeric whitespace-nowrap">
                    {money(p.paid_minor, p.currency)}
                  </td>
                  <td className="numeric whitespace-nowrap">
                    {money(p.outstanding_minor, p.currency)}
                  </td>
                  <td>
                    <Internal p={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!periods.data.data.length ? (
            <p className="py-5 text-muted">
              {t(
                Object.values(periodFilters).some(Boolean)
                  ? 'No billing periods match these filters.'
                  : 'No billing periods generated.',
              )}
            </p>
          ) : null}
          <Pages
            cursor={periodCursor}
            next={periods.data.page.next_cursor}
            set={setPeriodCursor}
          />
        </>
      )}
      {form === 'create' ? (
        <FinanceForm
          client={client}
          mode="agreement"
          close={() => setForm(null)}
        />
      ) : form === 'partner' ? (
        <FinanceForm
          client={client}
          mode="partner"
          close={() => setForm(null)}
        />
      ) : null}
      {selected ? (
        <AgreementDetail
          client={client}
          initial={selected}
          close={() => setSelected(null)}
        />
      ) : null}
    </section>
  )
}
function Internal({ p }: { p: Period }) {
  const n = BigInt(p.internal_remaining_to_roise_minor)
  return (
    <span className="text-sm tabular-nums">
      {money(String(n < 0n ? -n : n), p.currency)} ·{' '}
      {t(
        n > 0n
          ? 'Partner owes ROISE'
          : n < 0n
            ? 'ROISE owes partner'
            : 'Settled',
      )}
    </span>
  )
}
function AgreementDetail({
  client,
  initial,
  close,
}: {
  client: string
  initial: Agreement
  close: () => void
}) {
  const [a] = useState(initial)
  const op = useRecordOperations('agreements', client)
  const [cursor, setCursor] = useState('')
  const [transfer, setTransfer] = useState(false)
  const [mode, setMode] = useState<'terms' | null>(null)
  const q = useQuery({
    queryKey: [...op.key, 'versions', a.id, cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.versions(client, a.id, cursor, signal)),
  })
  const can = hasPermission(op.auth.session?.user.permissions ?? [], {
    permission: 'agreements.manage',
    scope: 'client',
    clientID: client,
  })
  const command = useRef<unknown>(null)
  const act = (status: string) => {
    const body = command.current ?? {
      command_id: crypto.randomUUID(),
      expected_revision: a.revision,
      status,
    }
    command.current = body
    void op
      .run(() => api.write(client, `agreements/${a.id}`, body, 'PUT'))
      .then((r) => {
        if (r) close()
      })
  }
  return (
    <Dialog
      open
      variant="drawer"
      title={a.title}
      description={t(
        'Historical periods retain their original terms. Changes apply to future periods.',
      )}
      onClose={() => {
        if (!op.pending) close()
      }}
    >
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <dt>{t('Status')}</dt>
        <dd>{t(a.status)}</dd>
        <dt>{t('Responsible manager')}</dt>
        <dd>{a.manager_name}</dd>
        <dt>{t('Start date')}</dt>
        <dd>{a.start_date}</dd>
        <dt>{t('Next period')}</dt>
        <dd>{a.next_date}</dd>
        <dt>{t('Timezone')}</dt>
        <dd>{a.timezone}</dd>
      </dl>
      {q.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : q.isError ? (
        <OperationsError
          error={q.error}
          retry={() => {
            void q.refetch()
          }}
        />
      ) : (
        <>
          <ul className="mt-6">
            {[...q.data.data]
              .sort((x, y) => Number(BigInt(y.number) - BigInt(x.number)))
              .map((v) => (
                <li key={v.id} className="border-t border-line py-5">
                  <p>
                    {t('Effective from')} · {v.effective_from}
                  </p>
                  <p className="mt-2 font-display text-2xl">
                    {money(v.amount_minor, v.currency)}
                  </p>
                  <p className="mt-2 text-sm">
                    ROISE · {money(v.roise_share_minor, v.currency)} ·{' '}
                    {v.partner_name ?? t('No partner')} ·{' '}
                    {money(
                      String(
                        BigInt(v.amount_minor) - BigInt(v.roise_share_minor),
                      ),
                      v.currency,
                    )}
                  </p>
                  <p className="mt-2 text-sm text-muted">
                    {t('Collector')}:{' '}
                    {t(
                      v.collector === 'roise' ? 'ROISE' : 'Advertising partner',
                    )}{' '}
                    · {t(v.allocation_policy)}
                  </p>
                </li>
              ))}
          </ul>
          <Pages
            cursor={cursor}
            next={q.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
      <AutomationFailure failure={a.automation_failure} />
      {can && ['active', 'paused'].includes(a.status) ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <Button disabled={op.pending} onClick={() => setTransfer(true)}>
            {t('Transfer automation responsibility')}
          </Button>
          <Button
            disabled={op.pending}
            onClick={() => act(a.status === 'active' ? 'paused' : 'active')}
          >
            {t(a.status === 'active' ? 'Pause agreement' : 'Resume agreement')}
          </Button>
          <Button disabled={op.pending} onClick={() => setMode('terms')}>
            {t('Schedule future terms')}
          </Button>
          <Button
            disabled={op.pending}
            variant="danger"
            onClick={() => {
              if (
                window.confirm(
                  t('Cancel future billing? Historical periods remain.'),
                )
              )
                act('cancelled')
            }}
          >
            {t('Cancel agreement')}
          </Button>
          {a.status === 'active' ? (
            <Button
              disabled={op.pending}
              onClick={() => {
                void op
                  .run(() =>
                    api.write(client, `agreements/${a.id}/generate`, {
                      billing_date: a.next_date,
                    }),
                  )
                  .then((r) => {
                    if (r) close()
                  })
              }}
            >
              {t('Generate due period')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {op.error ? (
        <p role="alert" className="mt-4 text-danger-ink">
          {copy(op.error)}
        </p>
      ) : null}
      {transfer ? (
        <ManagerTransfer
          client={client}
          id={a.id}
          revision={a.revision}
          current={a.managed_by}
          financial
          close={() => {
            setTransfer(false)
            close()
          }}
        />
      ) : null}
      {mode ? (
        <FinanceForm
          client={client}
          mode="terms"
          agreement={a}
          close={() => setMode(null)}
        />
      ) : null}
    </Dialog>
  )
}
function PeriodDetail({ client, id }: { client: string; id: string }) {
  const op = useRecordOperations('agreements', client)
  const [form, setForm] = useState<'payment' | 'settlement' | 'refund' | null>(
    null,
  )
  const [cursor, setCursor] = useState('')
  const [paymentCursor, setPaymentCursor] = useState('')
  const [reversalCursor, setReversalCursor] = useState('')
  const [voidForm, setVoidForm] = useState(false)
  const q = useQuery({
    queryKey: [...op.key, 'period', id],
    queryFn: ({ signal }) => op.read(() => api.readPeriod(client, id, signal)),
    refetchInterval: 30000,
  })
  const transfers = useQuery({
    queryKey: [...op.key, 'settlements', id, cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.settlements(client, id, cursor, signal)),
    enabled: q.isSuccess,
  })
  const payments = useQuery({
    queryKey: [...op.key, 'payments', id, paymentCursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        billing.payments(client, q.data!.collection_id, paymentCursor, signal),
      ),
    enabled: q.isSuccess,
  })
  const reversals = useQuery({
    queryKey: [...op.key, 'reversals', id, reversalCursor],
    queryFn: ({ signal }) =>
      op.read(() =>
        api.reversals(client, q.data!.collection_id, reversalCursor, signal),
      ),
    enabled: q.isSuccess,
  })
  const grants = op.auth.session?.user.permissions ?? []
  const can = (key: string) =>
    hasPermission(grants, {
      permission: key,
      scope: 'client',
      clientID: client,
    })
  if (q.isPending) return <PageSkeleton label={t('Loading finance…')} />
  if (q.isError)
    return (
      <OperationsError
        error={q.error}
        retry={() => {
          void q.refetch()
        }}
      />
    )
  const p = q.data
  return (
    <section>
      <OperationsHeader title={p.title} client={client}>
        <Link to={`/app/clients/${client}/finance`}>
          {t('Back to finance')}
        </Link>
      </OperationsHeader>
      {p.voided_at ? (
        <p
          role="status"
          className="mb-5 border-l-2 border-line-strong pl-4 text-sm"
        >
          {t('Voided period')} · {p.void_reason}
        </p>
      ) : null}
      <p className="text-sm text-muted">
        {t('Period')} · {p.period_key} · {t('Due date')} · {p.due_date ?? '—'}
      </p>
      <div className="mt-6 grid gap-5 border-y border-line py-6 sm:grid-cols-3">
        {[
          ['Contracted', p.amount_minor],
          ['Collected', p.paid_minor],
          ['Customer outstanding', p.outstanding_minor],
          ['ROISE share', p.roise_share_minor],
          ['Partner share', p.partner_share_minor],
        ].map(([label, amount]) => (
          <div key={label}>
            <p className="text-sm text-muted">{t(label!)}</p>
            <p className="mt-2 font-display text-3xl tabular-nums">
              {money(amount!, p.currency)}
            </p>
            {label === 'ROISE share' || label === 'Partner share' ? (
              <p className="mt-2 text-xs text-muted">
                {t('Allocated now')}:{' '}
                {money(
                  label === 'ROISE share'
                    ? p.roise_recognized_minor
                    : p.partner_recognized_minor,
                  p.currency,
                )}
              </p>
            ) : null}
          </div>
        ))}
        <div>
          <p className="text-sm text-muted">{t('Internal balance')}</p>
          <p className="mt-3">
            <Internal p={p} />
          </p>
        </div>
      </div>
      <p className="mt-5 text-sm">
        {t('Advertising partner')}: {p.partner_name ?? t('No partner')} ·{' '}
        {t('Collector')}:{' '}
        {t(p.collector === 'roise' ? 'ROISE' : 'Advertising partner')} ·{' '}
        {t(p.allocation_policy)}
      </p>
      <p className="mt-2 text-sm text-muted">
        {t(
          'The ROISE share is included in the consulting fee. Internal transfers do not charge the customer again.',
        )}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {can('agreements.manage') &&
        can('billing.delete') &&
        can('finance.approve_adjustment') &&
        !p.voided_at &&
        p.paid_minor === '0' ? (
          <Button variant="danger-ghost" onClick={() => setVoidForm(true)}>
            {t('Void unpaid period')}
          </Button>
        ) : null}
        {can('agreements.manage') &&
        (can('billing.update') || can('billing.manage')) &&
        p.outstanding_minor !== '0' &&
        !p.voided_at ? (
          <Button variant="primary" onClick={() => setForm('payment')}>
            {t('Record customer payment')}
          </Button>
        ) : null}
        {can('agreements.manage') &&
        p.partner_id &&
        p.internal_remaining_to_roise_minor !== '0' &&
        !p.voided_at ? (
          <Button onClick={() => setForm('settlement')}>
            {t('Record internal transfer')}
          </Button>
        ) : null}
        {can('billing.reverse') &&
        can('finance.approve_adjustment') &&
        p.paid_minor !== '0' ? (
          <Button onClick={() => setForm('refund')}>
            {t('Record refund')}
          </Button>
        ) : null}
        <Link to={`/app/clients/${client}/billing/${p.collection_id}`}>
          {t('Receivable details')}
        </Link>
      </div>
      <h2 className="section-heading mt-10">{t('Customer payments')}</h2>
      {payments.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : payments.isError ? (
        <OperationsError
          error={payments.error}
          retry={() => {
            void payments.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {payments.data.data.map((v) => (
              <li key={v.id} className="border-b border-line py-4">
                <p>
                  {money(v.amount_minor, v.currency)} · {v.paid_on} ·{' '}
                  {t(
                    v.collector === 'partner' ? 'Advertising partner' : 'ROISE',
                  )}
                </p>
                <MaskedReference
                  key={JSON.stringify(op.key) + v.id}
                  value={v.reference}
                />
              </li>
            ))}
          </ul>
          <Pages
            cursor={paymentCursor}
            next={payments.data.page.next_cursor}
            set={setPaymentCursor}
          />
        </>
      )}
      <h2 className="section-heading mt-8">{t('Internal transfers')}</h2>
      {transfers.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : transfers.isError ? (
        <OperationsError
          error={transfers.error}
          retry={() => {
            void transfers.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {transfers.data.data.map((v) => (
              <li key={v.id} className="border-b border-line py-4">
                {money(v.amount_minor, v.currency)} · {v.settled_on} ·{' '}
                {t(
                  v.direction === 'partner_to_roise'
                    ? 'Partner to ROISE'
                    : 'ROISE to partner',
                )}
              </li>
            ))}
          </ul>
          <Pages
            cursor={cursor}
            next={transfers.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
      <h2 className="section-heading mt-8">{t('Refund history')}</h2>
      {reversals.isPending ? (
        <PageSkeleton label={t('Loading finance…')} />
      ) : reversals.isError ? (
        <OperationsError
          error={reversals.error}
          retry={() => {
            void reversals.refetch()
          }}
        />
      ) : (
        <>
          <ul>
            {reversals.data.data.map((v) => (
              <li key={v.id} className="border-b border-line py-4">
                <p>
                  {money(v.amount_minor, v.currency)} · {v.reversed_on}
                </p>
                <p className="mt-1 text-sm text-muted">{v.reason}</p>
              </li>
            ))}
          </ul>
          <Pages
            cursor={reversalCursor}
            next={reversals.data.page.next_cursor}
            set={setReversalCursor}
          />
        </>
      )}
      {voidForm ? (
        <VoidPeriod period={p} close={() => setVoidForm(false)} />
      ) : null}
      {form ? (
        <FinanceForm
          client={client}
          mode={form}
          period={p}
          close={() => setForm(null)}
        />
      ) : null}
    </section>
  )
}
type Mode =
  | 'agreement'
  | 'terms'
  | 'partner'
  | 'payment'
  | 'settlement'
  | 'refund'
function FinanceForm(props: {
  client: string
  mode: Mode
  agreement?: Agreement
  period?: Period
  close: () => void
}) {
  const op = useRecordOperations('agreements', props.client)
  const q = useQuery({
    queryKey: [...op.key, 'business-settings'],
    queryFn: ({ signal }) => op.read(() => businessSettings(signal)),
    enabled: props.mode === 'agreement',
  })
  if (props.mode === 'refund')
    return props.period ? (
      <RefundForm
        record={{
          id: props.period.collection_id,
          client_id: props.client,
          currency: props.period.currency,
          revision: props.period.collection_revision,
        }}
        close={props.close}
      />
    ) : (
      <AccessDenied />
    )
  if (props.mode !== 'agreement')
    return (
      <FinanceEditor
        {...props}
        mode={props.mode}
        defaultZone={props.agreement?.timezone ?? 'UTC'}
      />
    )
  if (q.isPending || q.isError)
    return (
      <Dialog
        open
        variant="drawer"
        title={t('New service agreement')}
        description={t('Loading finance…')}
        onClose={props.close}
      >
        {q.isPending ? (
          <PageSkeleton label={t('Loading finance…')} />
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
  return (
    <FinanceEditor {...props} mode={props.mode} defaultZone={q.data.timezone} />
  )
}
function FinanceEditor({
  client,
  mode,
  agreement,
  period,
  close,
  defaultZone,
}: {
  defaultZone: string
  client: string
  mode: Exclude<Mode, 'refund'>
  agreement?: Agreement
  period?: Period
  close: () => void
}) {
  const op = useRecordOperations('agreements', client)
  const [snapshot] = useState(period)
  const [a] = useState(agreement)
  const [name, setName] = useState('')
  const [service, setService] = useState('software_maintenance')
  const [frequency, setFrequency] = useState('monthly')
  const [currency, setCurrency] = useState<Currency>(
    snapshot?.currency ?? a?.latest_terms.currency ?? 'USD',
  )
  const [amount, setAmount] = useState(
    a
      ? decimal(a.latest_terms.amount_minor, exponents[a.latest_terms.currency])
      : '',
  )
  const [share, setShare] = useState(
    a
      ? decimal(
          a.latest_terms.roise_share_minor,
          exponents[a.latest_terms.currency],
        )
      : '',
  )
  const [partner, setPartner] = useState(a?.latest_terms.partner_id ?? '')
  const [collector, setCollector] = useState(
    snapshot?.collector ?? a?.latest_terms.collector ?? 'roise',
  )
  const [policy, setPolicy] = useState(
    a?.latest_terms.allocation_policy ?? 'proportional',
  )
  const [date, setDate] = useState(() =>
    localDate(defaultZone, mode === 'terms'),
  )
  const [end, setEnd] = useState('')
  const [offset, setOffset] = useState('7')
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [cursor, setCursor] = useState('')
  const [locked, setLocked] = useState(false)
  const [localError, setLocalError] = useState('')
  const command = useRef(crypto.randomUUID())
  const sent = useRef<{
    path: string
    body: unknown
    method: 'POST' | 'PUT'
  } | null>(null)
  const termsMode = mode === 'agreement' || mode === 'terms'
  const partners = useQuery({
    queryKey: [...op.key, 'partners', cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.partners(client, cursor, signal)),
    enabled: termsMode,
  })
  const titles: Record<Exclude<Mode, 'refund'>, string> = {
    agreement: 'New service agreement',
    terms: 'Schedule future terms',
    partner: 'Add advertising partner',
    payment: 'Record customer payment',
    settlement: 'Record internal transfer',
  }
  return (
    <Dialog
      open
      variant="drawer"
      title={t(titles[mode])}
      description={t(
        'Review amounts and currency before saving. An uncertain result must be reconciled with the original command.',
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
          setLocalError('')
          try {
            if (!sent.current) {
              let body: unknown
              let path = ''
              let method: 'POST' | 'PUT' = 'POST'
              const minor =
                mode === 'partner' ? null : toMinor(amount, currency)
              if (mode === 'partner') {
                path = 'agreements/partners'
                body = { id: command.current, name }
              } else if (termsMode) {
                const terms = {
                  amount_minor: minor,
                  currency,
                  roise_share_minor: partner
                    ? share.trim() === '0'
                      ? '0'
                      : toMinor(share, currency)
                    : minor,
                  partner_id: partner || null,
                  collector: partner ? collector : 'roise',
                  allocation_policy: policy,
                }
                api.terms.parse(terms)
                path = mode === 'terms' ? `agreements/${a!.id}` : 'agreements'
                method = mode === 'terms' ? 'PUT' : 'POST'
                body =
                  mode === 'terms'
                    ? {
                        command_id: command.current,
                        expected_revision: a!.revision,
                        effective_from: date,
                        terms,
                      }
                    : {
                        command_id: command.current,
                        title: name,
                        service_type: service,
                        frequency,
                        start_date: date,
                        end_date: end || null,
                        due_offset_days: Number(offset),
                        terms,
                      }
              } else if (mode === 'payment') {
                path = `billing/${snapshot!.collection_id}/payments`
                body = {
                  command_id: command.current,
                  expected_revision: snapshot!.collection_revision,
                  amount_minor: minor,
                  currency,
                  collector,
                  paid_on: date,
                  method: 'bank_transfer',
                  reference,
                  note: reason,
                }
              } else if (mode === 'settlement') {
                path = `commercial-periods/${snapshot!.id}/settlements`
                body = {
                  command_id: command.current,
                  expected_revision: snapshot!.settlement_revision,
                  direction:
                    BigInt(snapshot!.internal_remaining_to_roise_minor) > 0n
                      ? 'partner_to_roise'
                      : 'roise_to_partner',
                  amount_minor: minor,
                  currency,
                  settled_on: date,
                  reference,
                  note: reason,
                }
              } else {
                throw new APIError(400, 'invalid_request')
              }
              sent.current = { path, body, method }
              setLocked(true)
            }
            const original = sent.current
            void op
              .run(
                () =>
                  termsMode || mode === 'partner' || mode === 'settlement'
                    ? api.write(
                        client,
                        original.path,
                        original.body,
                        original.method,
                      )
                    : api.paymentMutation(
                        client,
                        snapshot!.collection_id,
                        original.path.split('/').slice(2).join('/'),
                        original.body,
                      ),
                (failure) => {
                  if (failure instanceof APIError && failure.status === 400) {
                    sent.current = null
                    setLocked(false)
                  }
                },
              )
              .then((result) => {
                if (result) close()
              })
          } catch {
            setLocalError(
              t('Check the amount, currency, dates and allocation.'),
            )
          }
        }}
      >
        <fieldset disabled={op.pending || locked} className="space-y-5">
          {mode === 'partner' || mode === 'agreement' ? (
            <TextField
              required
              label={t(mode === 'partner' ? 'Partner name' : 'Service title')}
              maxLength={mode === 'partner' ? 100 : 200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : null}
          {mode === 'agreement' ? (
            <>
              <SelectField
                label={t('Service type')}
                value={service}
                onChange={(e) => setService(e.target.value)}
              >
                {[
                  'software_maintenance',
                  'software_development',
                  'advertising_consulting',
                  'other',
                ].map((v) => (
                  <option key={v} value={v}>
                    {t(v)}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={t('Frequency')}
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                {['monthly', 'once'].map((v) => (
                  <option key={v} value={v}>
                    {t(v)}
                  </option>
                ))}
              </SelectField>
            </>
          ) : null}
          {mode !== 'partner' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  required
                  inputMode="decimal"
                  label={t('Amount')}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <SelectField
                  label={t('Currency')}
                  value={currency}
                  disabled={!!snapshot || mode === 'terms'}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                >
                  {currencies.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </SelectField>
              </div>
              <TextField
                type="date"
                required
                label={t(
                  mode === 'agreement'
                    ? 'Start date'
                    : mode === 'terms'
                      ? 'Effective from'
                      : 'Payment date',
                )}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </>
          ) : null}
          {termsMode ? (
            <>
              <SelectField
                label={t('Advertising partner')}
                value={partner}
                onChange={(e) => setPartner(e.target.value)}
              >
                <option value="">{t('No partner')}</option>
                {partners.data?.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </SelectField>
              {partners.isError ? (
                <OperationsError
                  error={partners.error}
                  retry={() => {
                    void partners.refetch()
                  }}
                />
              ) : null}
              <Pages
                cursor={cursor}
                next={partners.data?.page.next_cursor ?? null}
                set={setCursor}
              />
              {partner ? (
                <>
                  <TextField
                    inputMode="decimal"
                    required
                    label={t('ROISE share included in total')}
                    value={share}
                    onChange={(e) => setShare(e.target.value)}
                  />
                  <SelectField
                    label={t('Collector')}
                    value={collector}
                    onChange={(e) =>
                      setCollector(e.target.value as 'roise' | 'partner')
                    }
                  >
                    <option value="roise">ROISE</option>
                    <option value="partner">{t('Advertising partner')}</option>
                  </SelectField>
                  <SelectField
                    label={t('Allocation policy')}
                    value={policy}
                    onChange={(e) =>
                      setPolicy(
                        e.target.value as 'proportional' | 'contractual',
                      )
                    }
                  >
                    <option value="proportional">
                      {t('Proportional to collected funds')}
                    </option>
                    <option value="contractual">
                      {t('Contractual shares due regardless of collection')}
                    </option>
                  </SelectField>
                </>
              ) : null}
            </>
          ) : null}
          {mode === 'agreement' ? (
            <details>
              <summary className="cursor-pointer text-sm">
                {t('Optional details')}
              </summary>
              <div className="mt-4 space-y-4">
                <TextField
                  label={t('End date')}
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
                <TextField
                  label={t('Days until payment is due')}
                  type="number"
                  min="0"
                  max="90"
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </div>
            </details>
          ) : null}
          {mode === 'payment' && snapshot?.partner_id ? (
            <SelectField
              label={t('Actual collector')}
              value={collector}
              onChange={(e) =>
                setCollector(e.target.value as 'roise' | 'partner')
              }
            >
              <option value="roise">ROISE</option>
              <option value="partner">{t('Advertising partner')}</option>
            </SelectField>
          ) : null}
          {['payment', 'settlement'].includes(mode) ? (
            <>
              <TextField
                label={t('Notes')}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <TextField
                label={t('Reference')}
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </>
          ) : null}
        </fieldset>
        {localError || op.error ? (
          <p role="alert" className="text-danger-ink">
            {localError || copy(op.error)}
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
          {op.pending
            ? t('Saving…')
            : t(locked ? 'Retry original command' : 'Save')}
        </Button>
      </form>
    </Dialog>
  )
}
