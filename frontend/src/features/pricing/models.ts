import { z } from '../../lib/validation'
import { APIError } from '../../services/authenticated'
import { uuid } from '../reminders/models'
import { currencies, dateSchema, revisionSchema } from '../billing/models'
import { exponents, maxInt64 } from '../billing/money'
import { halfUp, utcToday } from './exact'

export const kinds = ['recurring', 'one_time', 'custom'] as const
export const frequencies = [
  'none',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
] as const
export const unsigned = z
  .string()
  .max(19)
  .regex(/^(0|[1-9]\d*)$/)
  .refine((v) => /^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= maxInt64)
const bps = unsigned.refine((v) => BigInt(v) <= 10000n)
const text = (max: number, required = false, multiline = false) =>
  z
    .string()
    .transform((v) => v.replaceAll('\r\n', '\n').trim())
    .refine(
      (v) =>
        [...v].length <= max &&
        (!required || !!v) &&
        !/[\p{Cc}]/u.test(multiline ? v.replaceAll('\n', '') : v),
      `Use ${required ? '1–' : 'up to '}${max} characters without control characters.`,
    )
const lineBase = z
  .object({
    description: text(200, true),
    kind: z.enum(kinds),
    frequency: z.enum(frequencies),
    quantity_micros: revisionSchema,
    unit_price_minor: unsigned,
    discount_bps: bps,
    tax_bps: bps,
    unit_cost_minor: unsigned.optional(),
  })
  .strict()
const frequencyValid = (v: z.infer<typeof lineBase>) =>
  (v.kind !== 'recurring' || v.frequency !== 'none') &&
  (v.kind !== 'one_time' || v.frequency === 'none')
const lineInput = lineBase.refine(
  frequencyValid,
  'Recurring lines need a frequency; one-time lines use none.',
)
export const profileSchema = z
  .object({
    title: text(200, true),
    note: text(2000, false, true),
    currency: z.enum(currencies),
    effective_from: dateSchema,
    effective_until: dateSchema.nullable(),
    lines: z.array(lineInput).min(1).max(50),
  })
  .strict()
  .refine(
    (v) => !v.effective_until || v.effective_until > v.effective_from,
    'End date must be after start date.',
  )
export type Profile = z.infer<typeof profileSchema>
const totalFields = {
  base_minor: unsigned,
  discount_minor: unsigned,
  net_minor: unsigned,
  tax_minor: unsigned,
  total_minor: unsigned,
  cost_minor: unsigned.optional(),
}
const line = lineBase
  .extend({ position: z.number().int().min(1).max(50), ...totalFields })
  .refine(frequencyValid)
const calculationBase = z
  .object({
    currency: z.enum(currencies),
    currency_exponent: z.number().int(),
    lines: z.array(line).min(1).max(50),
    ...totalFields,
  })
  .strict()
export type Calculation = z.infer<typeof calculationBase>
function correct(c: Calculation) {
  try {
    if (c.currency_exponent !== exponents[c.currency]) return false
    const fields = [
      'base_minor',
      'discount_minor',
      'net_minor',
      'tax_minor',
      'total_minor',
    ] as const
    for (const [i, l] of c.lines.entries()) {
      const base = halfUp(l.quantity_micros, l.unit_price_minor, 1000000n),
        discount = halfUp(String(base), l.discount_bps, 10000n),
        net = base - discount,
        tax = halfUp(String(net), l.tax_bps, 10000n)
      if (
        l.position !== i + 1 ||
        fields.some(
          (f, j) => BigInt(l[f]) !== [base, discount, net, tax, net + tax][j],
        )
      )
        return false
      if (
        l.unit_cost_minor === undefined
          ? l.cost_minor !== undefined
          : l.cost_minor === undefined ||
            BigInt(l.cost_minor) !==
              halfUp(l.quantity_micros, l.unit_cost_minor, 1000000n)
      )
        return false
    }
    if (
      fields.some(
        (f) => BigInt(c[f]) !== c.lines.reduce((n, l) => n + BigInt(l[f]), 0n),
      )
    )
      return false
    const known = c.lines.every((l) => l.cost_minor !== undefined)
    return known
      ? c.cost_minor !== undefined &&
          BigInt(c.cost_minor) ===
            c.lines.reduce((n, l) => n + BigInt(l.cost_minor!), 0n)
      : c.cost_minor === undefined
  } catch {
    return false
  }
}
const calculation = calculationBase.refine(correct)
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine(
    (v) =>
      Number.isFinite(new Date(v).getTime()) &&
      v.slice(0, 4) !== '0000' &&
      new Date(v).toISOString().slice(0, 19) === v.slice(0, 19),
  )
const version = calculationBase
  .extend({
    id: uuid,
    sheet_id: uuid,
    client_id: uuid,
    revision: revisionSchema,
    title: text(200, true),
    note: text(2000, false, true),
    effective_from: dateSchema,
    effective_until: dateSchema.nullable(),
    window_until: dateSchema.nullable(),
    created_by: uuid,
    created_at: timestamp,
  })
  .refine(correct)
  .refine(
    (v) =>
      (!v.effective_until || v.effective_until > v.effective_from) &&
      (!v.window_until || v.window_until >= v.effective_from) &&
      (!v.effective_until ||
        (!!v.window_until && v.window_until <= v.effective_until)),
  )
export type Version = z.infer<typeof version>
const sheet = z
  .object({
    id: uuid,
    client_id: uuid,
    revision: revisionSchema,
    latest_version: version,
  })
  .strict()
  .refine(
    (v) =>
      v.latest_version.sheet_id === v.id &&
      v.latest_version.client_id === v.client_id &&
      v.latest_version.revision === v.revision,
  )
export type Sheet = z.infer<typeof sheet>
const snapshot = calculationBase
  .extend({
    collection_id: uuid,
    client_id: uuid,
    sheet_id: uuid,
    version_id: uuid,
    pricing_revision: revisionSchema,
    command_id: uuid,
    billing_date: dateSchema,
    title: text(200, true),
    created_by: uuid,
    created_at: timestamp,
  })
  .refine(correct)
  .refine((v) => v.total_minor !== '0')
export type Snapshot = z.infer<typeof snapshot>
export const copySchema = z
  .object({
    command_id: uuid,
    billing_date: dateSchema.refine(
      (v) => v <= utcToday(),
      'Billing date cannot be in the future.',
    ),
    due_date: dateSchema.nullable(),
    internal_note: text(8000, false, true),
  })
  .strict()
export type CopyInput = z.infer<typeof copySchema>
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) throw new APIError(0, 'invalid_response')
  return r.data
}
function costs(c: Calculation, allowed: boolean) {
  if (
    !allowed &&
    (c.cost_minor !== undefined ||
      c.lines.some(
        (l) => l.cost_minor !== undefined || l.unit_cost_minor !== undefined,
      ))
  )
    throw new APIError(0, 'invalid_response')
  return c
}
function page<T extends z.ZodType<{ id: string }>>(schema: T) {
  return z
    .object({
      data: z.array(schema).max(25),
      page: z
        .object({ limit: z.literal(25), next_cursor: uuid.nullable() })
        .strict(),
    })
    .strict()
    .refine(
      (v) =>
        v.data.every((r, i) => !i || r.id > v.data[i - 1]!.id) &&
        (!v.page.next_cursor ||
          (v.data.length === 25 && v.page.next_cursor === v.data.at(-1)?.id)),
    )
}
export function parseSheet(body: unknown, manage: boolean) {
  const s = parse(z.object({ data: sheet }).strict(), body).data
  costs(s.latest_version, manage)
  return s
}
export function parseSheets(body: unknown, manage: boolean) {
  const p = parse(page(sheet), body)
  p.data.forEach((s) => costs(s.latest_version, manage))
  return p
}
export function parseVersion(body: unknown, manage: boolean) {
  const v = parse(z.object({ data: version }).strict(), body).data
  costs(v, manage)
  return v
}
export function parseVersions(body: unknown, manage: boolean) {
  const p = parse(page(version), body)
  p.data.forEach((v) => costs(v, manage))
  return p
}
export function parseCalculation(body: unknown) {
  return parse(z.object({ data: calculation }).strict(), body).data
}
export function parseSnapshot(body: unknown) {
  const s = parse(z.object({ data: snapshot }).strict(), body).data
  costs(s, false)
  return s
}
export const parseMutation = (body: unknown) =>
  parse(
    z
      .object({
        data: z
          .object({ id: uuid, version_id: uuid, revision: revisionSchema })
          .strict(),
      })
      .strict(),
    body,
  ).data
export const parseCopy = (body: unknown) =>
  parse(
    z
      .object({
        data: z
          .object({ id: uuid, revision: revisionSchema, replayed: z.boolean() })
          .strict(),
      })
      .strict(),
    body,
  ).data
export const pagePath = (client: string, id?: string) =>
  `/app/clients/${client}/pricing${id ? '/' + id : ''}`
export const effective = (v: Version, day: string) =>
  dateSchema.safeParse(day).success &&
  day >= v.effective_from &&
  (!v.window_until || day < v.window_until)
export function profileOf(v: Version): Profile {
  return {
    title: v.title,
    note: v.note,
    currency: v.currency,
    effective_from:
      v.effective_from > utcToday() ? v.effective_from : utcToday(),
    effective_until: v.effective_until,
    lines: v.lines.map((l) => ({
      description: l.description,
      kind: l.kind,
      frequency: l.frequency,
      quantity_micros: l.quantity_micros,
      unit_price_minor: l.unit_price_minor,
      discount_bps: l.discount_bps,
      tax_bps: l.tax_bps,
      ...(l.unit_cost_minor === undefined
        ? {}
        : { unit_cost_minor: l.unit_cost_minor }),
    })),
  }
}
