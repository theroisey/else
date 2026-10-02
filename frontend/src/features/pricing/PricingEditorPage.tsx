import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { useForm, useFieldArray, useWatch } from 'react-hook-form'
import { Button, TextField, buttonStyles } from '../../components/ui'
import { AccessDenied } from '../clients/Shared'
import { currencies } from '../billing/models'
import { exponents } from '../billing/money'
import { usePricing } from './hooks'
import { PricingHeader, PricingError, Terms } from './Shared'
import type { Operation } from './Shared'
import {
  kinds,
  frequencies,
  profileSchema,
  profileOf,
  pagePath,
} from './models'
import type { Sheet, Profile, Calculation } from './models'
import {
  quantityInput,
  priceInput,
  percentInput,
  unscaled,
  utcToday,
} from './exact'
import * as api from './service'
interface DraftLine {
  description: string
  kind: Profile['lines'][number]['kind']
  frequency: Profile['lines'][number]['frequency']
  quantity: string
  price: string
  discount: string
  tax: string
  cost: string
}
interface Draft {
  title: string
  note: string
  currency: Profile['currency'] | ''
  effective_from: string
  effective_until: string
  lines: DraftLine[]
}
const emptyLine = (): DraftLine => ({
  description: '',
  kind: 'recurring',
  frequency: 'monthly',
  quantity: '1',
  price: '',
  discount: '0',
  tax: '0',
  cost: '',
})
function draftOf(s?: Sheet): Draft {
  if (!s)
    return {
      title: '',
      note: '',
      currency: '',
      effective_from: utcToday(),
      effective_until: '',
      lines: [emptyLine()],
    }
  const p = profileOf(s.latest_version),
    scale = exponents[p.currency]
  return {
    ...p,
    effective_until: p.effective_until ?? '',
    lines: p.lines.map((l) => ({
      description: l.description,
      kind: l.kind,
      frequency: l.frequency,
      quantity: unscaled(l.quantity_micros, 6),
      price: unscaled(l.unit_price_minor, scale),
      discount: unscaled(l.discount_bps, 2),
      tax: unscaled(l.tax_bps, 2),
      cost:
        l.unit_cost_minor === undefined
          ? ''
          : unscaled(l.unit_cost_minor, scale),
    })),
  }
}
export function PricingEditorPage({ create = false }: { create?: boolean }) {
  const { id = '', sheetID = '' } = useParams()
  return (
    <Editor
      key={id + ':' + sheetID + ':' + create}
      clientID={id}
      sheetID={sheetID}
      create={create}
    />
  )
}
function Editor({
  clientID,
  sheetID,
  create,
}: {
  clientID: string
  sheetID: string
  create: boolean
}) {
  const op = usePricing(clientID),
    sheet = useQuery({
      queryKey: [...op.key, 'detail', sheetID],
      queryFn: ({ signal }) =>
        op.read(() => api.detail(clientID, sheetID, true, signal)),
      enabled: op.permissions.manage && !create,
    })
  if (!op.permissions.manage) return <AccessDenied />
  return (
    <section>
      <PricingHeader
        title={
          create ? 'Create pricing agreement' : 'Create new pricing version'
        }
        operation={op}
      />
      {!create && sheet.isPending ? (
        <p role="status">Loading current pricing…</p>
      ) : !create && sheet.isError ? (
        <PricingError error={sheet.error} retry={() => void sheet.refetch()} />
      ) : (
        <PricingForm
          key={JSON.stringify(op.key) + ':' + (sheet.data?.revision ?? 'new')}
          operation={op}
          sheet={create ? undefined : sheet.data}
          checking={!create && sheet.isFetching}
        />
      )}
    </section>
  )
}
function PricingForm({
  operation: op,
  sheet,
  checking,
}: {
  operation: Operation
  sheet?: Sheet | undefined
  checking: boolean
}) {
  const navigate = useNavigate(),
    [preview, setPreview] = useState<{
      input: Profile
      calculation: Calculation
      stamp: string
    } | null>(null),
    [previewing, setPreviewing] = useState(false),
    [message, setMessage] = useState(''),
    [frozen, setFrozen] = useState(false)
  const { register, control, handleSubmit } = useForm<Draft>({
      defaultValues: draftOf(sheet),
    }),
    array = useFieldArray({ control, name: 'lines' }),
    stamp = JSON.stringify(useWatch({ control })),
    current = preview?.stamp === stamp ? preview : null
  const disabled =
    !op.writable || op.pending || previewing || frozen || checking
  async function calculate(d: Draft) {
    if (disabled) return
    setMessage('')
    setPreview(null)
    try {
      if (!d.currency) throw new Error('Choose a currency before previewing.')
      const currency = d.currency,
        input = profileSchema.parse({
          ...d,
          effective_until: d.effective_until || null,
          lines: d.lines.map((l, i) => {
            try {
              return {
                description: l.description,
                kind: l.kind,
                frequency: l.frequency,
                quantity_micros: quantityInput(l.quantity),
                unit_price_minor: priceInput(l.price, currency),
                discount_bps: percentInput(l.discount),
                tax_bps: percentInput(l.tax),
                ...(l.cost.trim()
                  ? { unit_cost_minor: priceInput(l.cost, currency) }
                  : {}),
              }
            } catch (e) {
              throw new Error(
                `Line ${i + 1}: ${e instanceof Error ? e.message : 'Check numeric inputs.'}`,
                { cause: e },
              )
            }
          }),
        })
      if (
        sheet &&
        (input.effective_from < utcToday() ||
          input.effective_from < sheet.latest_version.effective_from)
      )
        throw new Error(
          'New version starts on or after UTC today and the latest version start.',
        )
      setPreviewing(true)
      const calculation = await op.read(() => api.preview(op.clientID, input))
      setPreview({ input, calculation, stamp: JSON.stringify(d) })
    } catch (e) {
      setMessage(
        e instanceof Error && 'issues' in e
          ? 'Check title, line descriptions, frequencies and valid effective dates. End must be after start.'
          : e instanceof Error
            ? e.message
            : 'Unable to preview pricing.',
      )
    } finally {
      setPreviewing(false)
    }
  }
  async function save() {
    if (disabled || !current) return
    const input = current.input,
      result = await op.run(() =>
        sheet
          ? api.append(op.clientID, sheet.id, sheet.revision, input)
          : api.create(op.clientID, input),
      )
    if (result) navigate(pagePath(op.clientID, result.id), { replace: true })
    else {
      setFrozen(true)
      setMessage(
        'No new version is confirmed. Review current pricing and retained history before another write. A lost response may have committed; never append automatically.',
      )
    }
  }
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      className="grid gap-4"
    >
      <p className="text-sm text-muted">
        {sheet
          ? `Append to version ${sheet.revision}. Earlier pricing and billing copies stay unchanged. Same-day versions supersede earlier versions for that date.`
          : 'Choose one currency for this agreement. It stays fixed for every version.'}
      </p>
      <fieldset
        disabled={disabled}
        className="grid gap-4 rounded-md border border-line bg-surface p-4 sm:p-5"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Agreement title"
            maxLength={200}
            {...register('title')}
          />
          <label className="grid gap-1.5 text-sm font-semibold">
            Currency
            <select
              className="ui-input"
              {...register('currency')}
              disabled={!!sheet}
            >
              <option value="">Choose currency</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c} · {exponents[c]} decimal places
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Effective start (UTC calendar)"
            type="date"
            {...register('effective_from')}
          />
          <TextField
            label="Effective end (exclusive, UTC calendar)"
            type="date"
            {...register('effective_until')}
          />
        </div>
        <label className="grid gap-1.5 text-sm font-semibold">
          Pricing note
          <textarea
            className="ui-input min-h-24"
            maxLength={2000}
            {...register('note')}
          />
        </label>
        <p className="text-xs text-muted">
          End is optional and exclusive. A newer version caps the preceding
          effective window. Future versions may be scheduled; expired windows
          can leave gaps.
        </p>
      </fieldset>
      <fieldset disabled={disabled} className="grid min-w-0 gap-4">
        <legend className="mb-3 text-lg font-semibold">Agreement lines</legend>
        {array.fields.map((field, i) => (
          <article
            key={field.id}
            className="min-w-0 rounded-md border border-line bg-surface p-4 sm:p-5"
          >
            <h2 className="font-semibold">Line {i + 1}</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <TextField
                label={`Line ${i + 1} description`}
                maxLength={200}
                {...register(`lines.${i}.description`)}
              />
              <label className="grid gap-1.5 text-sm font-semibold">
                Line {i + 1} kind
                <select className="ui-input" {...register(`lines.${i}.kind`)}>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Line {i + 1} frequency
                <select
                  className="ui-input"
                  {...register(`lines.${i}.frequency`)}
                >
                  {frequencies.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <TextField
                label={`Line ${i + 1} quantity`}
                inputMode="decimal"
                maxLength={30}
                description="Up to six decimal places; greater than zero."
                {...register(`lines.${i}.quantity`)}
              />
              <TextField
                label={`Line ${i + 1} unit price`}
                inputMode="decimal"
                maxLength={30}
                description="Major units in the selected currency; zero allowed."
                {...register(`lines.${i}.price`)}
              />
              <TextField
                label={`Line ${i + 1} discount (%)`}
                inputMode="decimal"
                maxLength={8}
                {...register(`lines.${i}.discount`)}
              />
              <TextField
                label={`Line ${i + 1} tax (%)`}
                inputMode="decimal"
                maxLength={8}
                {...register(`lines.${i}.tax`)}
              />
              <TextField
                label={`Line ${i + 1} internal unit cost`}
                inputMode="decimal"
                maxLength={30}
                description="Optional; never copied to billing."
                {...register(`lines.${i}.cost`)}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="compact"
                disabled={!i}
                onClick={() => array.swap(i, i - 1)}
              >
                Move line {i + 1} up
              </Button>
              <Button
                size="compact"
                disabled={i === array.fields.length - 1}
                onClick={() => array.swap(i, i + 1)}
              >
                Move line {i + 1} down
              </Button>
              <Button
                size="compact"
                disabled={array.fields.length === 1}
                onClick={() => array.remove(i)}
              >
                Remove line {i + 1}
              </Button>
            </div>
          </article>
        ))}
        <Button
          disabled={array.fields.length >= 50}
          onClick={() => array.append(emptyLine())}
        >
          Add line
        </Button>
      </fieldset>
      {message ? (
        <p role="alert" className="text-danger-ink">
          {message}
        </p>
      ) : null}
      {op.error ? (
        <p role="alert" className="text-danger-ink">
          {op.error}
        </p>
      ) : null}
      {current ? (
        <>
          <p role="status">
            Preview matches the current draft. Confirm these fixed line totals
            before saving.
          </p>
          <Terms calculation={current.calculation} manage />
        </>
      ) : (
        <p className="text-sm text-muted">
          Preview required. Changes to any field invalidate the previous
          preview.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled}
          loading={previewing}
          onClick={() => void handleSubmit(calculate)()}
        >
          Preview pricing
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={disabled || !current}
          loading={op.pending}
        >
          {sheet ? 'Save new version' : 'Save pricing agreement'}
        </Button>
        <Link className={buttonStyles()} to={pagePath(op.clientID, sheet?.id)}>
          {frozen ? 'Review current pricing' : 'Cancel'}
        </Link>
      </div>
    </form>
  )
}
