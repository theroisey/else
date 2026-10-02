# Versioned pricing and immutable billing copies

Related Issue: [#21](https://github.com/theroisey/else/issues/21). The [calculation, timing, permission and recovery policy](https://github.com/theroisey/else/issues/21#issuecomment-5958282276) was recorded before implementation. This backend slice follows owner-merged billing #19 and finance interface #20. Pricing forms and history screens require a separate frontend PR; Issue #21 stays open.

## Exact arithmetic

Every sheet has one immutable currency and exponent from the existing billing catalog: USD/EUR/GBP/TRY use 2 decimals, JPY 0, KWD 3. Amounts and quantities are canonical integer strings; leading zeroes, signs, decimal/exponent notation and numeric JSON values are rejected. Money inputs are nonnegative int64 minor units. `quantity_micros` is positive int64, where `1000000` means one unit. `discount_bps` and `tax_bps` are string integers from `0` through `10000` (0–100%).

For each line, calculate these steps in order, with positive half-up rounding at each division:

1. `base = round(quantity_micros × unit_price_minor / 1000000)`.
2. `discount = round(base × discount_bps / 10000)`.
3. `net = base − discount`.
4. `tax = round(net × tax_bps / 10000)`.
5. `total = net + tax`.

Version totals sum already-rounded lines. For example, quantity `1500000`, unit price `1`, discount `2500` and tax `10000` produce base `2`, discount `1`, net `1`, tax `1`, total `2`. Two half-unit lines priced at `1` each total `2`; rounding their combined raw amount would incorrectly produce `1`.

Go uses `math/big.Int` intermediates; PostgreSQL uses exact `numeric`. Reject any calculated line or aggregate field above int64, including known internal costs. Optional unit cost uses quantity and the same base rounding independently of discount/tax. Aggregate cost is unknown when any line omits a cost. A zero-total pricing version is valid; billing copies require a positive total. No float arithmetic, FX, automatic invoices, proration, schedule multiplication or payment/refund changes are introduced.

## Agreement versions

A sheet contains immutable versions numbered by exact string revision. Each version owns its title (1–200 characters), optional note (up to 2000), UTC calendar effective dates and 1–50 ordered lines. Line descriptions are 1–200 characters. Newline is allowed only in notes. Text is trimmed by the Go adapter; control characters are rejected. Each line has `kind` (`recurring`, `one_time`, `custom`) and `frequency` (`none`, `weekly`, `monthly`, `quarterly`, `yearly`). Recurring lines require a frequency; one-time lines require `none`; custom lines permit either. Frequency is descriptive.

Create may start on a historical date. Append supplies the complete profile and the latest sheet's `expected_revision`. Its start must be on or after UTC today and on or after the previous version's start. Same-day appends supersede earlier versions for that day while retaining every original version. Future versions are allowed; cancellation/reordering of future versions is outside this contract. Currency cannot change within a sheet. Multiple sheets represent independent agreements for the client.

`effective_until` is nullable and exclusive, strictly after `effective_from`. Each successor caps the previous effective window. Stored original dates remain unchanged; `window_until` derives the earlier of the original end and the immediate successor's start. A same-day predecessor has an empty window. For an as-of date, select the highest version revision whose start is on or before that date, then check its original end. An expired selected version creates a gap; do not fall back to an older version. At most one version per sheet can be effective on a given date.

IDs, revision, client, creator, timestamps and all calculated values belong to the server. Original versions/lines cannot be edited, deleted or truncated. Lines may be inserted only in the transaction that creates their immutable header, including zero-value lines. Deferred constraints verify contiguous positions, exact totals, version sequences and copied line equality.

## API

Let `P = /api/v1/clients/:client_id/pricing`. All routes authenticate with existing cookie sessions and send `Cache-Control: no-store`. POST requires JSON, same-origin and CSRF checks. Unknown fields, extra bodies, query keys, duplicate/empty query values and bodies above 64 KiB are rejected. Errors use the shared envelope: invalid input 400, inaccessible/missing resources 404, stale revision/command/window/lifecycle conflicts 409, safe internal failures 500.

| Method and route | Purpose | Current permissions for this client |
| --- | --- | --- |
| GET `P` | List sheets with their latest versions | `pricing.view` |
| POST `P` | Create sheet and first version | `pricing.view` + `pricing.manage` |
| POST `P/preview` | Validate and calculate without storing/auditing | `pricing.view` + `pricing.manage` |
| GET `P/:sheet_id` | Latest version and sheet revision | `pricing.view` |
| GET `P/:sheet_id/versions` | Retained version history | `pricing.view` |
| GET `P/:sheet_id/versions/:version_id` | Original version with derived window | `pricing.view` |
| POST `P/:sheet_id/versions` | Append full version with `expected_revision` | `pricing.view` + `pricing.manage` |
| POST `P/:sheet_id/versions/:version_id/collections` | Explicit immutable billing copy | `pricing.view` + `billing.view` + `billing.create` |
| GET `/api/v1/clients/:client_id/billing/:collection_id/pricing-snapshot` | Retained copied terms | `billing.view` |

List responses are `{data: [...], page: {limit, next_cursor}}`. Both lists use stable ascending UUID order, independent of version chronology; each version has its chronological `revision`. Optional `limit` defaults to 25 and permits 1–100; `cursor` is the last returned UUID. Other responses are `{data: ...}`. Read pages/current details before a new mutation to obtain the latest sheet revision. Do not infer an effective version from the latest version alone: the latest may start in the future.

Create/append/preview profile:

```json
{
  "title": "Synthetic service agreement",
  "note": "Synthetic pricing note",
  "currency": "USD",
  "effective_from": "2020-02-29",
  "effective_until": null,
  "lines": [{
    "description": "Synthetic recurring service",
    "kind": "recurring",
    "frequency": "monthly",
    "quantity_micros": "1500000",
    "unit_price_minor": "101",
    "discount_bps": "2500",
    "tax_bps": "1000",
    "unit_cost_minor": "7"
  }]
}
```

Append adds `expected_revision` as a positive canonical string. Create/append return `{id, version_id, revision}` with status 201. Version documents include immutable original dates, derived `window_until`, creator/time, currency/exponent, ordered input/calculated lines and base/discount/net/tax/total strings. A sheet returns `{id, client_id, revision, latest_version}`. Preview returns currency/exponent, lines and totals, with status 200 and no mutation.

`unit_cost_minor` and line/aggregate `cost_minor` are omitted from API responses for actors without current `pricing.manage`. Unknown costs are omitted by the HTTP model even for managers. Costs never enter copied billing terms, audit markers, activity, logs or URLs. Existing role catalog/seeds remain unchanged at 33 permission keys; possession of `pricing.manage` alone never permits reads or writes.

## Explicit billing copy and reconciliation

Copy body:

```json
{
  "expected_revision": "1",
  "command_id": "c1000000-0000-4000-8000-000000000001",
  "billing_date": "2020-02-29",
  "due_date": null,
  "internal_note": "Synthetic collection note"
}
```

The chosen version must be effective on `billing_date`, which cannot be in the future. `expected_revision` is the latest sheet revision, even when copying a historical version. The backend copies that version's currency, computed total, title and retained lines/totals into one collection transaction. Clients cannot override the copied price or include costs. `due_date` is nullable; internal collection note allows 8000 characters. Collection currency and copied amount become immutable immediately. Existing metadata edits, append-only partial payments, settlement and cancellation keep their billing rules. The existing collection response is unchanged; copied terms live on the separate snapshot endpoint.

New copies return `{id, revision, replayed: false}` with 201. A client-scoped command UUID permanently identifies the original actor, sheet, version, expected revision, normalized billing date, due date and note. An identical committed retry returns the original collection ID, its **current collection revision**, and `replayed: true` with 200, without another collection/event. A changed payload, actor, selected version, sheet or expected revision using that UUID returns 409. A stale new command also returns 409.

On an unknown commit outcome, preserve the original command UUID and normalized payload, including the original expected revision. Reconcile using an explicit identical retry under current required permissions; never invent a replacement UUID or substitute a newer revision automatically. A 409 does not establish that an earlier command failed to commit. Read current collection/snapshot history and resolve the mismatch before a replacement. Ordinary create/append has no command replay contract: resolve an ambiguous version write through retained history and current revision before issuing another append.

Snapshot reads expose original sheet/version IDs, selected `pricing_revision`, command ID, billing date, title, creator/time, currency/exponent and copied ordered lines/totals. They omit pricing note, internal costs and collection note. They remain available under `billing.view` after pricing access is lost, later pricing edits, payments, cancellation or client archival. Non-pricing collections have no pricing snapshot and return 404. Archived clients retain pricing reads and committed copy reconciliation under current grants; new pricing writes/previews/copies are rejected.

## Authorization, audit and migrations

Every SQL function binds client, sheet, version and collection before exposing data. Writers acquire the existing authorization/lifecycle advisory lock and recheck grants/actor/client after waiting. Runtime receives EXECUTE only on six reviewed functions: read, list, preview, write, copy, snapshot-read. Private calculators/projectors and relational tables have no runtime or PUBLIC access. SECURITY DEFINER functions use fixed `pg_catalog` search paths and qualified tables.

Version creation and appends emit atomic `pricing.created`/`pricing.updated` events with only universal `exists` and exact revision markers. Copies emit one existing `billing.created` event. No raw profile/line/cost audit fields, fake activity events or audit-reader allowlist expansion is introduced. Failed business or audit writes roll back the entire version or collection/header/lines. Successful replay rolls back its read-only reconciliation transaction without an event.

Migration **000013** adds relational sheets, versions, pricing lines, snapshot headers and copied lines with composite client/currency foreign keys, immutable history guards, exact amount checks and deferred consistency constraints. It shares the existing currency catalog and permission keys. Apply the migration, then the reviewed runtime grants before serving the new API. Drain writers for DDL. Empty down/up preserves original billing/audit history and requires regranting the recreated functions. Down refuses any retained pricing/snapshot or pricing audit history; no production history cleanup or deployment is performed by this slice.

## Verification

Calculator tests exercise independent half-up ties, calculation order, scales, values above JavaScript's safe integer range, wide int64 intermediates, aggregate overflow, unknown costs and canonical field rejection. Real PostgreSQL tests compare Go/SQL results, historical/same-day/future/gapped windows, client/permission combinations, cost-key omission, unchanged billing payment/metadata/cancellation behavior, immediate copied-amount immutability, exact command replay and mismatches, audit rollback, immutable storage, runtime boundaries, stale revisions, concurrent append/copy and queued revocation/disable/archive. Migration tests exercise all thirteen empty versions and retained-history refusal. Existing frontend and real-browser regressions remain required CI gates.
