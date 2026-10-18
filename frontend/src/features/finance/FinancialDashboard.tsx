import { useDebouncedValue } from '../../lib/useDebouncedValue'
import * as commercial from '../operations/commercial-service'
import { periodRange } from './periods'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  PageHeader,
  SelectField,
  TextField,
  Table,
  Status,
  PageSkeleton,
} from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { formatDate } from '../../i18n/format'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { AccessDenied } from '../clients/Shared'
import { OperationsError } from '../operations/Shared'
import { clients } from '../clients/service'
import { currencies, labels, methodLabels } from '../billing/models'
import type { Currency } from '../billing/money'
import { amount, average, percent } from './exact'
import { Chart } from './Chart'
import { ExpenseWorkspace } from './Expenses'
import * as api from './service'
import type { Filters, Dashboard, Report } from './service'
const t = (s: string) => copy(s, 'finance')
const serviceNames = {
  software_maintenance: 'Software maintenance',
  software_development: 'Software development',
  advertising_consulting: 'Advertising consulting',
  other: 'Other services',
  unclassified: 'Unclassified',
}
const ageNames = {
  undated: 'No due date',
  future: 'Not yet due',
  today: 'Due today',
  '1_7': '1–7 days overdue',
  '8_15': '8–15 days overdue',
  '16_30': '16–30 days overdue',
  '31_60': '31–60 days overdue',
  '61_90': '61–90 days overdue',
  over_90: 'More than 90 days overdue',
}
const alertLabels = {
  over_90: 'Outstanding more than 90 days overdue',
  undated: 'Outstanding obligations without a due date',
  concentration_50:
    'One client represents at least 50% of positive net collections',
  reversals_10:
    'Reversals reach at least 10% of period gross collections, or gross is zero',
  unknown_collector: 'Customer cash attribution is incomplete',
  partner_receivable: 'Unsettled partner receivable',
  partner_payable: 'Unsettled partner payable',
  expenses_due_30: 'Operating payables due within 30 days',
} as const
const sections = [
  'Overview',
  'Receivables',
  'Clients',
  'Services',
  'Partners',
  'Payments',
  'Expenses',
  'Outlook',
] as const
type Section = (typeof sections)[number]
function defaults(): Filters {
  return {
    currency: 'EUR',
    ...periodRange('This month'),
    group: 'month',
    client_id: '',
    service_type: 'all',
    status: 'all',
    method: 'all',
    collector: 'all',
    agreement_id: '',
    partner_id: '',
    due_from: '',
    due_to: '',
    q: '',
  }
}
export function FinancialDashboard() {
  useLocale()
  const op = useRecordOperations('finance')
  const [filters, setFilters] = useState(defaults)
  const [draft, setDraft] = useState(filters)
  const [preset, setPreset] = useState('This month')
  const [section, setSection] = useState<Section>('Overview')
  const [clientSearch, setClientSearch] = useState('')
  const [clientCursor, setClientCursor] = useState('')
  const [clientLabel, setClientLabel] = useState('')
  const settledSearch = useDebouncedValue(clientSearch)
  const [agreementCursor, setAgreementCursor] = useState('')
  const [agreementName, setAgreementName] = useState('')
  const grants = op.auth.session?.user.permissions ?? [],
    allowed = hasPermission(grants, {
      permission: 'finance.read_company',
      scope: 'global',
    })
  const report = useQuery({
    queryKey: [...op.key, 'dashboard', filters],
    queryFn: ({ signal }) => op.read(() => api.dashboard(filters, signal)),
    enabled: allowed,
  })
  const brands = useQuery({
    queryKey: [...op.key, 'finance-clients', settledSearch, clientCursor],
    enabled: allowed && grants.some((g) => g.permission === 'clients.view'),
    queryFn: ({ signal }) =>
      op.read(() =>
        clients(
          { q: settledSearch, status: 'all', tag: '', sort: 'id' },
          clientCursor,
          signal,
        ),
      ),
  })
  const agreements = useQuery({
    queryKey: [...op.key, 'agreement-filter', draft.client_id, agreementCursor],
    enabled:
      allowed &&
      !!draft.client_id &&
      hasPermission(grants, {
        permission: 'agreements.view',
        scope: 'client',
        clientID: draft.client_id,
      }),
    queryFn: ({ signal }) =>
      op.read(() =>
        commercial.agreements(draft.client_id, agreementCursor, signal),
      ),
  })
  if (!allowed) return <AccessDenied />
  const data = report.data,
    currency = filters.currency as Currency
  const change = (key: keyof Filters, value: string) =>
    setDraft((v) => ({ ...v, [key]: value }))
  return (
    <section className="finance-dashboard">
      <PageHeader
        eyebrow={t('Financial intelligence')}
        title={t('Financial Dashboard')}
        description={t(
          'Collections, obligations and recorded cash movement, with a traceable source for every figure.',
        )}
      >
        <Link
          className="text-sm underline underline-offset-4"
          to="/app/finance"
        >
          {t('Manage service finance')}
        </Link>
      </PageHeader>
      <form
        className="filter-panel mb-5"
        onSubmit={(e) => {
          e.preventDefault()
          setFilters({ ...draft })
        }}
      >
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
          <SelectField
            label={t('Reporting period')}
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value)
              if (e.target.value !== 'Custom')
                setDraft((v) => ({
                  ...v,
                  ...periodRange(e.target.value),
                  group: e.target.value === 'All time' ? 'year' : v.group,
                }))
            }}
          >
            {[
              'Today',
              'Yesterday',
              'This week',
              'Last week',
              'This month',
              'Last month',
              'Last 30 days',
              'Last 90 days',
              'This quarter',
              'Last quarter',
              'This year',
              'Last year',
              'All time',
              'Custom',
            ].map((p) => (
              <option key={p} value={p}>
                {t(p)}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('From (UTC calendar)')}
            type="date"
            required
            value={draft.from}
            max={draft.to}
            onChange={(e) => {
              setPreset('Custom')
              change('from', e.target.value)
            }}
          />
          <TextField
            label={t('Through (UTC calendar)')}
            type="date"
            required
            value={draft.to}
            min={draft.from}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => {
              setPreset('Custom')
              change('to', e.target.value)
            }}
          />
          <SelectField
            label={t('Currency')}
            value={draft.currency}
            onChange={(e) => change('currency', e.target.value)}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </SelectField>
          <SelectField
            label={t('Trend interval')}
            value={draft.group}
            onChange={(e) => change('group', e.target.value)}
          >
            {['day', 'week', 'month', 'quarter', 'year'].map((p) => (
              <option key={p} value={p}>
                {t(p)}
              </option>
            ))}
          </SelectField>
        </div>
        <details className="mt-5">
          <summary className="cursor-pointer text-sm">
            {t('Advanced filters')}
          </summary>
          <div className="grid gap-4 mt-4 md:grid-cols-3">
            <TextField
              label={t('Find a client')}
              value={clientSearch}
              maxLength={100}
              onChange={(e) => {
                setClientSearch(e.target.value)
                setClientCursor('')
              }}
            />
            <SelectField
              label={t('Client')}
              value={draft.client_id}
              onChange={(e) => {
                setDraft((v) => ({
                  ...v,
                  client_id: e.target.value,
                  agreement_id: '',
                  partner_id: '',
                }))
                setAgreementCursor('')
                setClientLabel(
                  brands.data?.data.find((r) => r.id === e.target.value)
                    ?.name ?? '',
                )
              }}
            >
              <option value="">{t('All authorized clients')}</option>
              {draft.client_id &&
              !brands.data?.data.some((b) => b.id === draft.client_id) ? (
                <option value={draft.client_id}>
                  {hasPermission(grants, {
                    permission: 'clients.view',
                    scope: 'client',
                    clientID: draft.client_id,
                  })
                    ? clientLabel
                    : t('Unavailable')}
                </option>
              ) : null}
              {brands.data?.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
            <div className="flex gap-3 items-end">
              <Button
                onClick={() => setClientCursor('')}
                disabled={!clientCursor}
              >
                {t('First clients')}
              </Button>
              <Button
                disabled={!brands.data?.page.next_cursor}
                onClick={() =>
                  setClientCursor(brands.data?.page.next_cursor ?? '')
                }
              >
                {t('Next clients')}
              </Button>
            </div>
            {draft.client_id && agreements.isSuccess ? (
              <>
                <SelectField
                  label={t('Agreement')}
                  value={draft.agreement_id}
                  onChange={(e) => {
                    change('agreement_id', e.target.value)
                    setAgreementName(
                      agreements.data.data.find((v) => v.id === e.target.value)
                        ?.title ?? '',
                    )
                  }}
                >
                  <option value="">{t('All agreements')}</option>
                  {draft.agreement_id &&
                  !agreements.data.data.some(
                    (v) => v.id === draft.agreement_id,
                  ) ? (
                    <option value={draft.agreement_id}>{agreementName}</option>
                  ) : null}
                  {agreements.data.data.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </SelectField>
                <div className="flex gap-3 items-end">
                  <Button
                    disabled={!agreementCursor}
                    onClick={() => setAgreementCursor('')}
                  >
                    {t('First agreements')}
                  </Button>
                  <Button
                    disabled={!agreements.data.page.next_cursor}
                    onClick={() =>
                      setAgreementCursor(agreements.data.page.next_cursor ?? '')
                    }
                  >
                    {t('Next agreements')}
                  </Button>
                </div>
              </>
            ) : null}
            <SelectField
              label={t('Partner')}
              value={draft.partner_id}
              onChange={(e) => change('partner_id', e.target.value)}
            >
              <option value="">{t('All partners')}</option>
              {report.data?.partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Service')}
              value={draft.service_type}
              onChange={(e) => change('service_type', e.target.value)}
            >
              <option value="all">{t('All services')}</option>
              {Object.entries(serviceNames).map(([k, v]) => (
                <option key={k} value={k}>
                  {t(v)}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Current obligation status')}
              value={draft.status}
              onChange={(e) => change('status', e.target.value)}
            >
              <option value="all">{t('All statuses')}</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {copy(v, 'billing')}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Payment method')}
              value={draft.method}
              onChange={(e) => change('method', e.target.value)}
            >
              <option value="all">{t('All methods')}</option>
              {Object.entries(methodLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {copy(v, 'billing')}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('Actual collector')}
              value={draft.collector}
              onChange={(e) => change('collector', e.target.value)}
            >
              {['all', 'roise', 'partner', 'unknown'].map((v) => (
                <option value={v} key={v}>
                  {t(
                    v === 'all'
                      ? 'All collectors'
                      : v === 'roise'
                        ? 'ROISE'
                        : v === 'partner'
                          ? 'Partner'
                          : 'Unknown',
                  )}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t('Due from')}
              type="date"
              value={draft.due_from}
              onChange={(e) => change('due_from', e.target.value)}
            />
            <TextField
              label={t('Due through')}
              type="date"
              value={draft.due_to}
              onChange={(e) => change('due_to', e.target.value)}
            />
            <TextField
              label={t('Client or obligation text')}
              maxLength={100}
              value={draft.q}
              onChange={(e) => change('q', e.target.value)}
            />
          </div>
          <p className="text-xs text-muted mt-3">
            {t(
              'Payment method and collector affect customer payment activity only. Expenses use currency, client and payment dates; service, status and collector filters do not apply to expenses. Current position is independent of the activity date range.',
            )}
          </p>
        </details>
        <div className="flex flex-wrap gap-3 mt-5">
          <Button type="submit" variant="primary">
            {t('Apply filters')}
          </Button>
          <Button
            onClick={() => {
              const v = defaults()
              setDraft(v)
              setFilters(v)
              setPreset('This month')
              setClientLabel('')
            }}
          >
            {t('Reset filters')}
          </Button>
        </div>
      </form>
      <nav className="finance-sections" aria-label={t('Financial sections')}>
        {sections.map((s) => (
          <button
            key={s}
            type="button"
            aria-current={section === s ? 'page' : undefined}
            onClick={() => setSection(s)}
          >
            {t(s)}
          </button>
        ))}
      </nav>
      {report.isPending ? (
        <PageSkeleton />
      ) : report.isError ? (
        <OperationsError
          error={report.error}
          retry={() => void report.refetch()}
        />
      ) : data ? (
        <>
          <p className="text-xs text-muted py-4">
            {t('Activity dates')}: {data.from} – {data.to} · {currency} ·{' '}
            {t('Current position as of')}{' '}
            {formatDate(data.as_of, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
          {section === 'Overview' ? (
            <Overview data={data} currency={currency} select={setSection} />
          ) : null}
          {section === 'Receivables' ||
          section === 'Clients' ||
          section === 'Payments' ? (
            <Details
              key={section + JSON.stringify(filters)}
              report={
                section === 'Receivables'
                  ? 'receivables'
                  : section === 'Clients'
                    ? 'clients'
                    : 'payments'
              }
              filters={filters}
            />
          ) : null}
          {section === 'Services' ? (
            <>
              <Explanation>
                {t(
                  'Service classification comes from authorized immutable service periods. General charges and restricted service terms remain unclassified. Contract values are actual obligations, not proposals or future billing potential.',
                )}
              </Explanation>
              <SummaryTable
                title="Service performance"
                headers={[
                  'Service',
                  'Actual obligations',
                  'Net collected against obligations',
                  'Net collections in period',
                  'Outstanding',
                  'Obligations',
                ]}
                rows={data.services.map((s) => [
                  t(serviceNames[s.label]),
                  amount(s.amount_minor, currency),
                  amount(s.paid_minor, currency),
                  amount(s.activity_minor, currency),
                  amount(s.outstanding_minor, currency),
                  s.count,
                ])}
              />
            </>
          ) : null}
          {section === 'Partners' ? (
            <>
              <Explanation>
                {t(
                  'Current signed reconciliation uses original contractual terms and net collections. Positive balances are due to ROISE; negative balances are payable. Transfers are never customer income.',
                )}
              </Explanation>
              <SummaryTable
                title="Partner reconciliation"
                headers={[
                  'Partner',
                  'Contracted allocation · ROISE',
                  'Contracted allocation · partner',
                  'Recognized allocation · ROISE',
                  'Recognized allocation · partner',
                  'Internal receivable',
                  'Internal payable',
                  'Signed balance',
                ]}
                rows={data.partners.map((p) => [
                  p.name,
                  amount(p.roise_share_minor, currency),
                  amount(p.partner_share_minor, currency),
                  amount(p.roise_recognized_minor, currency),
                  amount(p.partner_recognized_minor, currency),
                  amount(p.receivable_minor, currency),
                  amount(p.payable_minor, currency),
                  amount(p.balance_minor, currency),
                ])}
              />
              <Link className="underline text-sm" to="/app/finance">
                {t('Open source agreements and settlements')}
              </Link>
            </>
          ) : null}
          {section === 'Expenses' ? (
            <ExpenseWorkspace
              key={op.key.join('|') + currency + filters.client_id}
              currency={currency}
              client={filters.client_id}
            />
          ) : null}
          {section === 'Outlook' ? (
            <Outlook data={data} currency={currency} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
export function Explanation({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-muted leading-6 my-5 max-w-4xl">{children}</p>
  )
}
export function SummaryTable({
  title,
  headers,
  rows,
}: {
  title: string
  headers: string[]
  rows: ReactNode[][]
}) {
  return (
    <section className="workspace-section">
      <h2 className="text-lg mb-4">{t(title)}</h2>
      {rows.length ? (
        <Table caption={t(title)}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th scope="col" className={i ? 'numeric' : ''} key={h}>
                  {t(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={j ? 'numeric' : ''}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted">
          {t('No eligible records for this selection.')}
        </p>
      )}
    </section>
  )
}
function Metric({
  title,
  value,
  definition,
  onClick,
}: {
  title: string
  value: string
  definition: string
  onClick: () => void
}) {
  return (
    <div className="finance-metric">
      <button className="text-left w-full" onClick={onClick}>
        <span className="eyebrow">{t(title)}</span>
        <span className="block mt-3 text-2xl lg:text-3xl font-display break-words tabular-nums">
          {value}
        </span>
      </button>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">{t('Definition')}</summary>
        <p className="mt-2 leading-5">{t(definition)}</p>
      </details>
    </div>
  )
}
function Overview({
  data: d,
  currency: c,
  select,
}: {
  data: Dashboard
  currency: Currency
  select: (s: Section) => void
}) {
  const [cumulative, setCumulative] = useState(false)
  const change = String(
      BigInt(d.activity.net_minor) - BigInt(d.previous.net_minor),
    ),
    averagePayment = average(d.activity.net_minor, d.activity.payment_count),
    completion = percent(d.position.paid_minor, d.position.amount_minor)
  const expenses = d.expenses,
    knownCash =
      expenses && d.cashflow
        ? String(
            BigInt(d.activity.roise_minor) +
              BigInt(d.settlements.incoming_minor) -
              BigInt(d.settlements.outgoing_minor) -
              BigInt(expenses.activity.net_minor),
          )
        : null
  const totalNet = BigInt(d.positive_client_net_minor),
    top = d.concentration.filter((v) => BigInt(v.net_minor) > 0n)
  return (
    <>
      <div className="finance-executive">
        <div className="finance-lead">
          <p className="eyebrow">{t('Net collections in period')}</p>
          <button onClick={() => select('Payments')} className="finance-total">
            {amount(d.activity.net_minor, c)}
          </button>
          <p className="text-sm text-muted mt-4">
            {t('Gross collections')} {amount(d.activity.gross_minor, c)}
            <br />
            {t('Payment reversals')} {amount(d.activity.reversed_minor, c)}
          </p>
          <p className="text-xs text-muted mt-3">
            {d.from === '0001-01-01' ? (
              t('Comparison unavailable for all time.')
            ) : (
              <>
                {t('Previous equal-length period')}: {d.previous_from} –{' '}
                {d.previous_to}
                <br />
                {amount(change, c)} ·{' '}
                {percent(change, d.previous.net_minor) ??
                  t('No positive comparison baseline')}
              </>
            )}
          </p>
        </div>
        <div className="finance-support">
          <Metric
            title="Current outstanding"
            value={amount(d.position.outstanding_minor, c)}
            definition="Active customer obligations minus net retained payments, independent of the activity date filter."
            onClick={() => select('Receivables')}
          />
          <Metric
            title="Current overdue"
            value={amount(d.position.overdue_minor, c)}
            definition="Active outstanding with a UTC due date strictly before today. Missing due dates are separate."
            onClick={() => select('Receivables')}
          />
          <Metric
            title="Collection completion"
            value={completion ?? t('Not applicable')}
            definition="Current net paid divided by current active obligation amount, using the same eligible cohort."
            onClick={() => select('Clients')}
          />
        </div>
      </div>
      <Button
        aria-pressed={cumulative}
        onClick={() => setCumulative((v) => !v)}
      >
        {t(
          cumulative
            ? 'Show period collections'
            : 'Show cumulative collections',
        )}
      </Button>
      <div className="finance-two-column">
        <Chart
          title={
            cumulative ? 'Cumulative net collections' : 'Collections over time'
          }
          currency={c}
          rows={d.trends.map((r) => ({
            label: r.period,
            value: cumulative ? r.cumulative_minor : r.net_minor,
          }))}
        />
        <Chart
          title="Receivables aging"
          currency={c}
          rows={d.aging.map((r) => ({
            label: t(ageNames[r.bucket]),
            value: r.amount_minor,
          }))}
        />
      </div>
      {d.cashflow ? (
        <Chart
          title="Monthly recorded cash movement"
          currency={c}
          rows={d.cashflow.map((r) => ({
            label: r.period,
            value: r.net_minor,
          }))}
        />
      ) : null}
      <details className="finance-disclosure">
        <summary>{t('Reconciliation and collection states')}</summary>
        {d.prior_year ? (
          <SummaryTable
            title="Year-over-year collections"
            headers={['Measure', 'Amount']}
            rows={[
              [
                d.year_from + ' – ' + d.year_to,
                amount(d.prior_year.net_minor, c),
              ],
              [
                t('Absolute change'),
                amount(
                  String(
                    BigInt(d.activity.net_minor) -
                      BigInt(d.prior_year.net_minor),
                  ),
                  c,
                ),
              ],
              [
                t('Percentage change'),
                percent(
                  String(
                    BigInt(d.activity.net_minor) -
                      BigInt(d.prior_year.net_minor),
                  ),
                  d.prior_year.net_minor,
                ) ?? t('No positive comparison baseline'),
              ],
            ]}
          />
        ) : null}
        <SummaryTable
          title="Financial reconciliation"
          headers={['Measure', 'Amount']}
          rows={[
            [t('Active obligations'), amount(d.position.amount_minor, c)],
            [
              t('Net collected against obligations'),
              amount(d.position.paid_minor, c),
            ],
            [t('Current outstanding'), amount(d.position.outstanding_minor, c)],
            [
              t('Issued obligations in period'),
              amount(d.position.issued_minor, c),
            ],
            [
              t('Cancelled original obligations'),
              amount(d.position.cancelled_amount_minor, c),
            ],
            [
              t('Retained payments on cancelled obligations'),
              amount(d.position.cancelled_paid_minor, c),
            ],
            [
              t('Average net payment event'),
              averagePayment === null
                ? t('Not applicable')
                : amount(averagePayment, c),
            ],
            [
              t('Average debtor exposure'),
              average(d.position.outstanding_minor, d.position.debtor_count) ===
              null
                ? t('Not applicable')
                : amount(
                    average(
                      d.position.outstanding_minor,
                      d.position.debtor_count,
                    )!,
                    c,
                  ),
            ],
          ]}
        />
        <SummaryTable
          title="Collection states"
          headers={['State', 'Obligations', 'Amount']}
          rows={[
            [
              t('Fully paid'),
              d.position.paid_count,
              amount(d.position.fully_paid_minor, c),
            ],
            [
              t('Partially paid'),
              d.position.partial_count,
              amount(d.position.partial_outstanding_minor, c),
            ],
            [
              t('Unpaid'),
              d.position.unpaid_count,
              amount(d.position.unpaid_minor, c),
            ],
            [
              t('Overdue · may overlap partial or unpaid'),
              d.position.overdue_count,
              amount(d.position.overdue_minor, c),
            ],
            [
              t('Cancelled'),
              d.position.cancelled_count,
              amount(d.position.cancelled_amount_minor, c),
            ],
          ]}
        />
      </details>
      <details className="finance-disclosure">
        <summary>{t('Cash movement and operating expenses')}</summary>
        <SummaryTable
          title="Recorded organizational cash movement"
          headers={['Movement', 'Amount']}
          rows={[
            [
              t('Customer net receipts collected by ROISE'),
              amount(d.activity.roise_minor, c),
            ],
            [
              t('Incoming partner settlements'),
              amount(d.settlements.incoming_minor, c),
            ],
            [
              t('Outgoing partner settlements'),
              amount(d.settlements.outgoing_minor, c),
            ],
            [
              t('Operating payments less reversals'),
              expenses
                ? amount(expenses.activity.net_minor, c)
                : t('Restricted'),
            ],
            [
              t('Recorded cash surplus'),
              knownCash === null ? t('Unavailable') : amount(knownCash, c),
            ],
            [
              t('Unknown collector · excluded from cash'),
              amount(d.activity.unknown_minor, c),
            ],
          ]}
        />
        {d.expenses ? (
          <SummaryTable
            title="Operating expense position"
            headers={['Measure', 'Amount']}
            rows={[
              [
                t('Recorded expenses in period'),
                amount(d.expenses.position.recorded_minor, c),
              ],
              [
                t('Current operating payables'),
                amount(d.expenses.position.outstanding_minor, c),
              ],
              [
                t('Overdue operating payables'),
                amount(d.expenses.position.overdue_minor, c),
              ],
              [
                t('Operating payables due within 30 days'),
                amount(d.expenses.position.upcoming_minor, c),
              ],
            ]}
          />
        ) : null}
        {d.expenses ? (
          <Chart
            title="Monthly paid operating expenses"
            currency={c}
            rows={d.expenses.trends.map((r) => ({
              label: r.period,
              value: r.net_minor,
            }))}
          />
        ) : null}
        {d.expenses ? (
          <SummaryTable
            title="Expense vendors"
            headers={['Vendor or payee', 'Net paid expenses']}
            rows={d.expenses.vendors.map((v) => [
              v.label || t('Unknown'),
              amount(v.amount_minor, c),
            ])}
          />
        ) : null}
        {d.expenses ? (
          <SummaryTable
            title="Expense categories"
            headers={['Category', 'Net paid expenses']}
            rows={d.expenses.categories.map((v) => [
              v.label,
              amount(v.amount_minor, c),
            ])}
          />
        ) : null}
        <Explanation>
          {t(
            'Recorded cash movement is limited to accessible, recorded transactions. Unknown collectors and unrecorded spending are excluded. This is neither a bank balance nor accounting net profit. Pricing cost estimates are not operating expenses.',
          )}
        </Explanation>
      </details>
      <details className="finance-disclosure">
        <summary>{t('Payment composition')}</summary>
        <SummaryTable
          title="Collection concentration"
          headers={['Client group', 'Share of net collections']}
          rows={[1, 3, 5, 10].map((n) => [
            t('Top') + ' ' + n,
            totalNet > 0n
              ? percent(
                  String(
                    top
                      .slice(0, n)
                      .reduce((v, r) => v + BigInt(r.net_minor), 0n),
                  ),
                  d.positive_client_net_minor,
                )
              : t('Not applicable'),
          ])}
        />
        <SummaryTable
          title="Payment methods"
          headers={['Method', 'Net amount', 'Payment events']}
          rows={d.methods.map((v) => [
            copy(
              methodLabels[v.label as keyof typeof methodLabels] ?? v.label,
              'billing',
            ),
            amount(v.amount_minor, c),
            v.count,
          ])}
        />
      </details>
      <SummaryTable
        title="Financial attention"
        headers={['Condition', 'Amount', 'Review']}
        rows={d.alerts.map((a) => [
          <span>
            <Status tone={a.tone}>{t(alertLabels[a.rule])}</Status>
            {a.name ? (
              <span className="block text-xs text-muted mt-2">{a.name}</span>
            ) : null}
          </span>,
          amount(a.amount_minor, c),
          <button className="underline" onClick={() => select(a.target)}>
            {t(a.target)}
          </button>,
        ])}
      />
      <SummaryTable
        title="Financial attention · oldest deadlines first"
        headers={['Client / obligation', 'Due date', 'Outstanding']}
        rows={d.attention.map((a) => [
          <Link to={`/app/clients/${a.client_id}/billing/${a.id}`}>
            {a.client_name} · {a.description}
          </Link>,
          a.due_date ?? t('No due date'),
          amount(a.outstanding_minor, c),
        ])}
      />
    </>
  )
}
function Outlook({
  data: d,
  currency: c,
}: {
  data: Dashboard
  currency: Currency
}) {
  const [share, setShare] = useState('100')
  const raw = /^(100|[0-9]{1,2})$/.test(share) ? BigInt(share) : null
  return (
    <>
      <Explanation>
        {t(
          'Cumulative windows include today and existing unpaid obligations only. A collection scenario is hypothetical; it creates no charge and promises no future cash. Future ungenerated service fees and undated obligations are excluded.',
        )}
      </Explanation>
      <SummaryTable
        title="Service agreements"
        headers={[
          'Status',
          'Agreements',
          'Potential next billing within 90 days',
        ]}
        rows={d.agreements.map((a) => [
          copy(
            a.label === 'active'
              ? 'Active'
              : a.label === 'paused'
                ? 'Paused'
                : a.label === 'cancelled'
                  ? 'Cancelled'
                  : 'Expired',
            'operations',
          ),
          a.count,
          amount(a.potential_next_minor, c),
        ])}
      />
      <Explanation>
        {t(
          'Potential agreement billing includes only the next eligible scheduled charge per active agreement. It is not an issued receivable, recurring revenue or confirmed cash.',
        )}
      </Explanation>
      <TextField
        label={t('Scenario collection percentage')}
        type="number"
        min="0"
        max="100"
        step="1"
        value={share}
        onChange={(e) => setShare(e.target.value)}
      />
      <SummaryTable
        title="Existing receivable outlook"
        headers={[
          'Horizon · days',
          'Existing amount due',
          'Obligations',
          'Scenario amount',
        ]}
        rows={d.upcoming.map((w) => [
          w.days,
          amount(w.amount_minor, c),
          w.count,
          raw === null
            ? t('Enter 0–100')
            : amount(String((BigInt(w.amount_minor) * raw + 50n) / 100n), c),
        ])}
      />
      <SummaryTable
        title="Aging detail"
        headers={[
          'Age',
          'Outstanding',
          'Obligations',
          'Clients',
          'Share of outstanding',
        ]}
        rows={d.aging.map((v) => [
          t(ageNames[v.bucket]),
          amount(v.amount_minor, c),
          v.count,
          v.clients,
          percent(v.amount_minor, d.position.outstanding_minor) ??
            t('Not applicable'),
        ])}
      />
    </>
  )
}
function Details({ report, filters }: { report: Report; filters: Filters }) {
  const op = useRecordOperations('finance')
  const [cursor, setCursor] = useState('')
  const [sort, setSort] = useState('source')
  const q = useQuery({
    queryKey: [...op.key, report, filters, cursor],
    queryFn: ({ signal }) =>
      op.read(() => api.details(report, filters, cursor, signal)),
  })
  if (q.isPending) return <PageSkeleton />
  if (q.isError)
    return <OperationsError error={q.error} retry={() => void q.refetch()} />
  const sorted = [...q.data.data].sort((a, b) => {
    if (sort === 'amount') {
      return compareExact(
        'amount_minor' in a ? a.amount_minor : '0',
        'amount_minor' in b ? b.amount_minor : '0',
      )
    }
    if (sort === 'outstanding') {
      return compareExact(
        'outstanding_minor' in a ? a.outstanding_minor : '0',
        'outstanding_minor' in b ? b.outstanding_minor : '0',
      )
    }
    if (sort === 'client') return a.client_name.localeCompare(b.client_name)
    if (sort === 'due') {
      const av =
        'due_date' in a
          ? a.due_date
          : 'occurred_on' in a
            ? a.occurred_on
            : a.next_due
      const bv =
        'due_date' in b
          ? b.due_date
          : 'occurred_on' in b
            ? b.occurred_on
            : b.next_due
      return (av ?? '9999-12-31').localeCompare(bv ?? '9999-12-31')
    }
    return 0
  })
  const c = filters.currency as Currency
  const headers =
    report === 'receivables'
      ? [
          'Client / obligation',
          'Actual obligations',
          'Net collected against obligations',
          'Outstanding',
          'Due date',
          'Status',
        ]
      : report === 'clients'
        ? [
            'Client',
            'Actual obligations',
            'Net collected against obligations',
            'Outstanding',
            'Overdue',
            'Collection completion',
            'Net collections in period',
            'Obligations',
            'Latest recorded payment',
            'Next due date',
          ]
        : [
            'Client / obligation',
            'Business date',
            'Recorded at',
            'Amount',
            'Method',
            'Actual collector',
            'Event',
          ]
  const rows: ReactNode[][] = sorted.map((r) =>
    'description' in r && 'outstanding_minor' in r
      ? [
          <Link to={`/app/clients/${r.client_id}/billing/${r.id}`}>
            {r.client_name} · {r.description}
          </Link>,
          amount(r.amount_minor, c),
          amount(r.paid_minor, c),
          amount(r.outstanding_minor, c),
          r.due_date ?? t('No due date'),
          copy(labels[r.status], 'billing'),
        ]
      : 'overdue_minor' in r
        ? [
            <Link to={`/app/clients/${r.id}/billing`}>{r.client_name}</Link>,
            amount(r.amount_minor, c),
            amount(r.paid_minor, c),
            amount(r.outstanding_minor, c),
            amount(r.overdue_minor, c),
            percent(r.paid_minor, r.amount_minor) ?? t('Not applicable'),
            amount(r.activity_minor, c),
            r.count,
            r.last_payment_on ?? t('Unknown'),
            r.next_due ?? t('No due date'),
          ]
        : 'collection_id' in r
          ? [
              <Link
                to={`/app/clients/${r.client_id}/billing/${r.collection_id}`}
              >
                {r.client_name} · {r.description}
              </Link>,
              r.occurred_on,
              formatDate(r.recorded_at, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
              amount(
                r.kind === 'reversal' ? '-' + r.amount_minor : r.amount_minor,
                c,
              ),
              copy(methodLabels[r.method], 'billing'),
              t(
                r.collector === 'roise'
                  ? 'ROISE'
                  : r.collector === 'partner'
                    ? 'Partner'
                    : 'Unknown',
              ),
              t(r.kind === 'payment' ? 'Payment' : 'Reversal'),
            ]
          : [],
  )
  return (
    <>
      <Explanation>
        {t(
          report === 'payments'
            ? 'Payments use payment business dates; reversals use reversal business dates. Recorded timestamp is shown separately. Original events remain retained.'
            : 'This table shows the current position for the selected record attributes, independent of the payment activity date range.',
        )}
      </Explanation>
      <SelectField
        label={t('Sort current page')}
        value={sort}
        onChange={(e) => setSort(e.target.value)}
      >
        {[
          ['source', 'Source order'],
          ['amount', 'Amount descending'],
          ['outstanding', 'Outstanding descending'],
          ['due', 'Date ascending'],
          ['client', 'Client name'],
        ].map(([k, v]) => (
          <option key={k} value={k}>
            {t(v!)}
          </option>
        ))}
      </SelectField>
      <SummaryTable
        title={
          report === 'receivables'
            ? 'Receivables report'
            : report === 'clients'
              ? 'Client financial performance'
              : 'Collections report'
        }
        headers={headers}
        rows={rows}
      />
      <div className="flex flex-wrap gap-3 py-4">
        <Button onClick={() => setCursor('')} disabled={!cursor}>
          {t('First page')}
        </Button>
        <Button
          disabled={!q.data.page.next_cursor}
          onClick={() => setCursor(q.data.page.next_cursor ?? '')}
        >
          {t('Next page')}
        </Button>
      </div>
    </>
  )
}

function compareExact(a: string, b: string) {
  const x = BigInt(a),
    y = BigInt(b)
  return x > y ? -1 : x < y ? 1 : 0
}
