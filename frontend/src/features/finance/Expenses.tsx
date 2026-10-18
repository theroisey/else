import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  TextField,
  SelectField,
  PageSkeleton,
  Table,
} from '../../components/ui'
import { copy, useLocale } from '../../i18n'
import { useRecordOperations } from '../auth/useRecordOperations'
import { hasPermission } from '../auth/permissions'
import { OperationsError } from '../operations/Shared'
import { toMinor, type Currency } from '../billing/money'
import { currencies, methodLabels } from '../billing/models'
import { amount } from './exact'
import { useExpenseRecovery } from './recovery-context'
import * as api from './service'
const t = (s: string) => copy(s, 'finance')
function Pages({
  cursor,
  next,
  set,
}: {
  cursor: string
  next: string | null | undefined
  set: (v: string) => void
}) {
  return (
    <div className="flex gap-3 mt-4">
      <Button disabled={!cursor} onClick={() => set('')}>
        {t('First page')}
      </Button>
      <Button disabled={!next} onClick={() => set(next ?? '')}>
        {t('Next page')}
      </Button>
    </div>
  )
}
export function ExpenseWorkspace({
  currency,
  client,
}: {
  currency: Currency
  client: string
}) {
  useLocale()
  const op = useRecordOperations('finance'),
    recovery = useExpenseRecovery()
  const [cursor, setCursor] = useState(''),
    [categoryCursor, setCategoryCursor] = useState(''),
    [selected, setSelected] = useState(''),
    [creating, setCreating] = useState(false),
    [categoryName, setCategoryName] = useState(''),
    [categoryId, setCategoryId] = useState(() => crypto.randomUUID()),
    [error, setError] = useState('')
  const [filters, setFilters] = useState<api.ExpenseFilters>({
      status: 'all',
      category_id: '',
      q: '',
    }),
    [draftFilters, setDraftFilters] = useState(filters),
    [exporting, setExporting] = useState(false)
  const grants = op.auth.session?.user.permissions ?? [],
    allowed = hasPermission(grants, {
      permission: 'expenses.view',
      scope: 'global',
    }),
    manage =
      allowed &&
      hasPermission(grants, { permission: 'expenses.manage', scope: 'global' })
  const list = useQuery({
    queryKey: [...op.key, 'expenses', currency, client, filters, cursor],
    enabled: allowed,
    queryFn: ({ signal }) =>
      op.read(() => api.expenses(currency, cursor, signal, client, filters)),
  })
  const categories = useQuery({
    queryKey: [...op.key, 'expense-categories', categoryCursor],
    enabled: allowed,
    queryFn: ({ signal }) =>
      op.read(() => api.categories(categoryCursor, signal)),
  })
  if (!allowed)
    return (
      <p className="workspace-section">
        {t('Operating expenses require a separate explicit permission.')}
      </p>
    )
  if (selected)
    return (
      <ExpenseDetail
        key={selected}
        id={selected}
        manage={manage}
        back={() => setSelected('')}
      />
    )
  async function category() {
    const v = await op.run(() => api.addCategory(categoryId, categoryName))
    if (v) {
      setCategoryName('')
      setCategoryId(crypto.randomUUID())
      setCategoryCursor('')
    }
  }
  async function exportPage() {
    setExporting(true)
    setError('')
    try {
      const result = await op.read(() =>
        api.exportExpenses(currency, client, filters, cursor),
      )
      const url = URL.createObjectURL(
        new Blob([result.csv], { type: 'text/csv;charset=utf-8' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = `roisey-expenses-${currency}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError(t('Unable to export this page. Retry after checking access.'))
    } finally {
      setExporting(false)
    }
  }
  return (
    <section className="workspace-section">
      <form
        className="filter-panel grid gap-4 md:grid-cols-3 mb-5"
        onSubmit={(e) => {
          e.preventDefault()
          setFilters({ ...draftFilters })
          setCursor('')
        }}
      >
        <SelectField
          label={t('Expense status')}
          value={draftFilters.status}
          onChange={(e) =>
            setDraftFilters((v) => ({ ...v, status: e.target.value }))
          }
        >
          {[
            ['all', 'All statuses'],
            ['open', 'Open'],
            ['paid', 'Paid'],
            ['overdue', 'Overdue'],
            ['cancelled', 'Cancelled'],
          ].map(([k, label]) => (
            <option key={k} value={k}>
              {t(label!)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('Expense category')}
          value={draftFilters.category_id}
          onChange={(e) =>
            setDraftFilters((v) => ({ ...v, category_id: e.target.value }))
          }
        >
          <option value="">{t('All categories')}</option>
          {categories.data?.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('Expense title or vendor')}
          maxLength={100}
          value={draftFilters.q}
          onChange={(e) =>
            setDraftFilters((v) => ({ ...v, q: e.target.value }))
          }
        />
        <Button type="submit">{t('Apply filters')}</Button>
        <Button disabled={exporting} onClick={() => void exportPage()}>
          {t('Export this page (CSV)')}
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
        <h2 className="text-lg">{t('Operating expenses')}</h2>
        {manage ? (
          <Button
            disabled={recovery.busy}
            onClick={() => setCreating((v) => !v)}
          >
            {t(creating ? 'Close new expense' : 'Record an expense')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted mb-6">
        {t(
          'Operating payables are independent of customer charges and partner transfers. Paid expenses are recorded transactions, not pricing estimates or complete accounting costs.',
        )}
      </p>
      <p className="text-sm text-muted mb-6">
        {t(
          'This table shows the current position for the selected record attributes, independent of the payment activity date range.',
        )}
      </p>
      {creating ? (
        <form
          className="finance-form"
          onSubmit={(e) => {
            e.preventDefault()
            setError('')
            try {
              const d = new FormData(e.currentTarget),
                get = (k: string) => String(d.get(k) ?? '')
              const c = get('currency') as Currency
              recovery.submit({
                path: '',
                summary:
                  get('title') + ' · ' + amount(toMinor(get('amount'), c), c),
                input: {
                  command_id: crypto.randomUUID(),
                  client_id: client || null,
                  category_id: get('category'),
                  title: get('title'),
                  vendor: get('vendor'),
                  description: get('description'),
                  currency: c,
                  amount_minor: toMinor(get('amount'), c),
                  expense_date: get('expense_date'),
                  due_date: get('due_date') || null,
                },
              })
            } catch (f) {
              setError(
                f instanceof Error
                  ? copy(f.message)
                  : t('Check the expense values.'),
              )
            }
          }}
        >
          <fieldset
            disabled={recovery.busy}
            className="grid gap-4 md:grid-cols-2"
          >
            <TextField
              label={t('Expense title')}
              name="title"
              required
              maxLength={200}
            />
            <TextField
              label={t('Vendor or payee')}
              name="vendor"
              maxLength={200}
            />
            <SelectField label={t('Category')} name="category" required>
              <option value="">{t('Choose a category')}</option>
              {categories.data?.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            <Pages
              cursor={categoryCursor}
              next={categories.data?.page.next_cursor}
              set={setCategoryCursor}
            />
            <SelectField
              name="currency"
              label={t('Currency')}
              defaultValue={currency}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
            <TextField
              label={t('Amount')}
              name="amount"
              inputMode="decimal"
              required
              maxLength={24}
            />
            <TextField
              label={t('Expense date')}
              name="expense_date"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
              max={new Date().toISOString().slice(0, 10)}
            />
            <TextField label={t('Due date')} name="due_date" type="date" />
            <TextField
              label={t('Description')}
              name="description"
              maxLength={4000}
            />
            <Button type="submit" variant="primary">
              {t('Review expense command')}
            </Button>
          </fieldset>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      ) : null}
      {manage ? (
        <details className="my-6">
          <summary className="text-sm cursor-pointer">
            {t('Add an expense category')}
          </summary>
          <div className="flex flex-wrap items-end gap-3 mt-4">
            <TextField
              label={t('Category name')}
              required
              maxLength={100}
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
            />
            <Button
              disabled={!categoryName.trim() || op.pending}
              onClick={() => void category()}
            >
              {t('Add category')}
            </Button>
          </div>
          {op.error ? <p role="alert">{copy(op.error)}</p> : null}
        </details>
      ) : null}
      {list.isPending ? (
        <PageSkeleton />
      ) : list.isError ? (
        <OperationsError error={list.error} retry={() => void list.refetch()} />
      ) : (
        <>
          <Table caption={t('Operating expenses')}>
            <thead>
              <tr>
                {[
                  'Expense',
                  'Category',
                  'Amount',
                  'Paid',
                  'Outstanding',
                  'Due date',
                  'Status',
                ].map((h) => (
                  <th key={h} scope="col">
                    {t(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      className="underline text-left"
                      onClick={() => setSelected(r.id)}
                    >
                      {r.title}
                    </button>
                    <p className="text-xs text-muted">{r.vendor}</p>
                  </td>
                  <td>{r.category_name}</td>
                  <td className="numeric">
                    {amount(r.amount_minor, r.currency)}
                  </td>
                  <td className="numeric">
                    {amount(r.paid_minor, r.currency)}
                  </td>
                  <td className="numeric">
                    {amount(r.outstanding_minor, r.currency)}
                  </td>
                  <td>{r.due_date ?? t('No due date')}</td>
                  <td>
                    {t(
                      r.cancelled_at
                        ? 'Cancelled'
                        : r.outstanding_minor === '0'
                          ? 'Paid'
                          : 'Open',
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!list.data.data.length ? (
            <p className="text-sm text-muted py-5">
              {t('No eligible records for this selection.')}
            </p>
          ) : null}
          <Pages
            cursor={cursor}
            next={list.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
    </section>
  )
}
function ExpenseDetail({
  id,
  manage,
  back,
}: {
  id: string
  manage: boolean
  back: () => void
}) {
  const op = useRecordOperations('finance'),
    recovery = useExpenseRecovery()
  const [cursor, setCursor] = useState('')
  const [reversing, setReversing] = useState<api.ExpenseEvent | null>(null)
  const detail = useQuery({
      queryKey: [...op.key, 'expense', id],
      queryFn: ({ signal }) => op.read(() => api.expense(id, signal)),
    }),
    history = useQuery({
      queryKey: [...op.key, 'expense-history', id, cursor],
      queryFn: ({ signal }) => op.read(() => api.events(id, cursor, signal)),
    })
  if (detail.isPending) return <PageSkeleton />
  if (detail.isError)
    return (
      <OperationsError
        error={detail.error}
        retry={() => void detail.refetch()}
      />
    )
  const r = detail.data
  return (
    <section className="workspace-section">
      <Button onClick={back}>{t('Back to expenses')}</Button>
      <h2 className="mt-6 text-xl font-display break-words">{r.title}</h2>
      <p className="my-3 text-muted">
        {r.vendor} · {r.category_name}
      </p>
      <p className="text-sm mb-6">
        {t('Outstanding')}: {amount(r.outstanding_minor, r.currency)} ·{' '}
        {t('Paid')}: {amount(r.paid_minor, r.currency)}
      </p>
      {manage && !r.cancelled_at ? (
        <ExpenseEditor
          key={r.id + ':' + reversing?.id}
          r={r}
          reversing={reversing}
          clearReversal={() => setReversing(null)}
          unused={history.data?.data.length === 0}
        />
      ) : null}
      <h3 className="text-lg mt-7 mb-4">{t('Retained payment history')}</h3>
      {history.isPending ? (
        <PageSkeleton />
      ) : history.isError ? (
        <OperationsError
          error={history.error}
          retry={() => void history.refetch()}
        />
      ) : (
        <>
          <Table caption={t('Retained payment history')}>
            <thead>
              <tr>
                {[
                  'Event',
                  'Business date',
                  'Amount',
                  'Payment method',
                  'Correction reason',
                  'Action',
                ].map((h) => (
                  <th key={h} scope="col">
                    {t(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.data.data.map((e) => (
                <tr key={e.id}>
                  <td>{t(e.kind === 'payment' ? 'Payment' : 'Reversal')}</td>
                  <td>{e.occurred_on}</td>
                  <td className="numeric">
                    {amount(e.amount_minor, r.currency)}
                  </td>
                  <td>{copy(methodLabels[e.method], 'billing')}</td>
                  <td>{e.reason}</td>
                  <td>
                    {manage && e.kind === 'payment' ? (
                      <Button
                        disabled={recovery.busy}
                        onClick={() => setReversing(e)}
                      >
                        {t('Reverse payment')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pages
            cursor={cursor}
            next={history.data.page.next_cursor}
            set={setCursor}
          />
        </>
      )}
    </section>
  )
}

function ExpenseEditor({
  r,
  reversing,
  clearReversal,
  unused,
}: {
  r: api.Expense
  reversing: api.ExpenseEvent | null
  clearReversal: () => void
  unused: boolean
}) {
  const recovery = useExpenseRecovery(),
    [error, setError] = useState(''),
    [originalRevision, setOriginalRevision] = useState(r.revision),
    [reset, setReset] = useState(0)
  return (
    <div key={reset}>
      {r.revision !== originalRevision ? (
        <div role="alert" className="my-4">
          <p>
            {t(
              'The expense changed. Review its history before resetting this draft.',
            )}
          </p>
          <Button
            onClick={() => {
              setOriginalRevision(r.revision)
              setReset((v) => v + 1)
            }}
          >
            {t('Discard draft and load current revision')}
          </Button>
        </div>
      ) : null}
      <form
        className="finance-form"
        key={r.id + ':' + reversing?.id}
        onSubmit={(e) => {
          e.preventDefault()
          setError('')
          try {
            const d = new FormData(e.currentTarget)
            recovery.submit({
              path: `/${r.id}/events`,
              summary:
                r.title +
                ' · ' +
                amount(
                  toMinor(String(d.get('amount')), r.currency),
                  r.currency,
                ),
              input: {
                command_id: crypto.randomUUID(),
                expected_revision: originalRevision,
                payment_id: reversing?.id ?? null,
                amount_minor: toMinor(String(d.get('amount')), r.currency),
                occurred_on: String(d.get('date')),
                method: String(d.get('method')),
                reason: String(d.get('reason') ?? ''),
              },
            })
          } catch (f) {
            setError(
              f instanceof Error
                ? copy(f.message)
                : t('Check the expense values.'),
            )
          }
        }}
      >
        <h3 className="text-sm font-medium mb-4">
          {t(
            reversing
              ? 'Reverse an expense payment'
              : 'Record an expense payment',
          )}
        </h3>
        <fieldset
          className="grid gap-4 md:grid-cols-2"
          disabled={recovery.busy || r.revision !== originalRevision}
        >
          <TextField
            label={t('Amount')}
            name="amount"
            required
            inputMode="decimal"
            maxLength={24}
          />
          <TextField
            label={t('Business date')}
            name="date"
            type="date"
            required
            defaultValue={new Date().toISOString().slice(0, 10)}
            max={new Date().toISOString().slice(0, 10)}
          />
          <SelectField label={t('Payment method')} name="method">
            {Object.entries(methodLabels)
              .filter(([k]) => !reversing || k === reversing.method)
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {copy(v, 'billing')}
                </option>
              ))}
          </SelectField>
          <TextField
            label={t('Correction reason')}
            name="reason"
            maxLength={2000}
            required={!!reversing}
          />
          <Button variant="primary" type="submit">
            {t('Review expense command')}
          </Button>
          {reversing ? (
            <Button onClick={() => clearReversal()}>
              {t('Cancel reversal')}
            </Button>
          ) : null}
        </fieldset>
        {error ? <p role="alert">{error}</p> : null}
      </form>
      {unused ? (
        <Button
          className="my-4"
          disabled={recovery.busy || r.revision !== originalRevision}
          onClick={() =>
            recovery.submit({
              path: `/${r.id}/cancel`,
              summary: r.title + ' · ' + amount(r.amount_minor, r.currency),
              input: {
                command_id: crypto.randomUUID(),
                expected_revision: originalRevision,
              },
            })
          }
        >
          {t('Cancel unused expense')}
        </Button>
      ) : null}
    </div>
  )
}
