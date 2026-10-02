# Authorized client operational overview

Related Issue: [#23](https://github.com/theroisey/else/issues/23). This backend slice consumes owner-merged tasks, reminders, finance, pricing and activity. The [financial/access policy](https://github.com/theroisey/else/issues/23#issuecomment-5960242616) preceded implementation. The owner merged PR #66 at `378e5cf` after all five final-head gates passed; main run 37060547663 passed and both branches synchronized. The [overview interface](overview-interface.md) consumes this contract in a separate frontend PR.

## Read contract

`GET /api/v1/clients/:client_id/overview` returns `{ "data": Overview }` with `Cache-Control: no-store`. It accepts no query parameters, cursors, filters, caller clock or variable limits, including a bare `?`. Other methods return 405 with `Allow: GET`; invalid paths/IDs return 400. Authentication runs first. A missing session or disabled session user returns 401. A real client and current exact-client `clients.view` are mandatory; missing, foreign and unauthorized clients all return the same 404. Archived clients remain readable.

The required fields are `client: { id, name, status, archived_at }`, UTC `as_of` and `horizon_end`. Status is `active` or `archived`. The horizon is exactly seven days (168 hours) after the database statement's instant. No contacts, notes, tags, actor expansion or full source records enter this response.

| Optional key | Current exact-client grant | Shape |
| --- | --- | --- |
| `finance` | `billing.view` | `{ currencies: Totals[] }` |
| `tasks` | `tasks.view` | `{ overdue: Queue<Task>, due_soon: Queue<Task> }` |
| `reminders` | `reminders.view` | `{ due: Queue<Reminder>, upcoming: Queue<Reminder> }` |
| `activity` | `activity.view` plus existing source-module rules | `Queue<ActivityItem>` |

An inaccessible key is omitted entirely. An authorized empty queue is `{ items: [], has_more: false }`; empty finance is `{ currencies: [] }`. There are no permission flags, hidden module counts, fabricated zero balances or integration metrics. Consumers should link authorized attention rows to existing workspaces and render unavailable integrations honestly.

## Exact finance

`finance.currencies` reuses `app.billing_summary` and the existing [billing Totals DTO](billing.md) unchanged, ordered by currency. Each currency carries `currency`, `currency_exponent` and the canonical exact strings `amount_minor`, `paid_minor`, `outstanding_minor`, `overdue_minor`, `cancelled_amount_minor`, `cancelled_paid_minor`. USD/EUR/GBP/TRY use exponent 2, JPY 0, KWD 3. Aggregation uses PostgreSQL numeric and preserves totals above signed 64-bit limits. Never convert these strings through JavaScript Number or add different currencies.

Active amount/paid/outstanding and overdue reconcile with every client collection, independently of collection page size. Cancelled obligations and their retained payments remain separate history. Overdue uses the source ledger's UTC calendar-date rule. Immutable pricing copies participate only as collections; later pricing changes cannot rewrite them. Pricing previews, internal costs, notes, payment references, FX, forecasts and a cross-currency grand total are absent.

## Bounded attention

Every queue returns at most five rows. It reads one additional eligible row to derive `has_more`, without an exact total count or follow-up query. `has_more` directs the interface to the source workspace; it is not a cursor.

Tasks include only unarchived, nonterminal records with a deadline. `due_at <= as_of` is overdue; `as_of < due_at <= horizon_end` is due soon. Done, cancelled, archived, undated and later tasks are excluded. Earliest deadline then UUID orders each queue. Task fields are `id`, `title`, `status`, `priority`, UTC `due_at`; descriptions and assignees are absent.

Reminders include only pending records. `scheduled_at <= as_of` is due; `as_of < scheduled_at <= horizon_end` is upcoming. Earliest schedule then UUID orders each queue. Reminder fields are `id`, `title`, UTC `scheduled_at`, stored IANA `timezone`; owners, descriptions and resource references are absent. This is a projection of stored schedules, not reminder delivery or recurrence.

Activity reuses the existing guarded [safe projection](activity.md) and reviewed static Go summaries. It returns the newest five eligible events ordered by `occurred_at DESC, id DESC`, with the existing `id`, `client_id`, `occurred_at`, `event_type`, `resource_kind`, `resource_id`, `summary` fields. Source permissions filter before the sixth-row indicator, so hidden events never imply more visible history. Billing, pricing, administrative and raw audit payloads remain outside that projection.

## Authorization, consistency and cost

The overview service executes one runtime aggregate SQL statement per read, with no module/row fanout. `app.client_overview` takes the shared transaction advisory lifecycle lock `871092650209` before fresh client/module checks. Existing guarded writers take its exclusive form. Reads queued behind a revocation, disabled user, archive or cancellation therefore observe the committed change; concurrent overview readers can share the lock. A read produces no audit event or business mutation.

`as_of` is the SQL statement's start instant, including when it waits for the lock. Once acquired, the lock pins guarded lifecycle/access changes through the projection; it does not promise consistency against unguarded database-owner edits. Existing HTTP deadlines and cancellation bound lock waits. Exact finance still scans indexed records for that client; bounded output does not imply constant work for an arbitrarily large ledger. Tasks/reminders sample six rows per queue, and activity performs its existing indexed source-permission filtering. One partial task deadline index supports the new range projection; reminder/activity/finance indexes are reused. No persistent aggregate or duplicate balance is introduced.

## Migration and runtime

Migration `000014_client_overview.sql` adds only the partial `tasks_open_due` index and PUBLIC-revoked `SECURITY DEFINER VOLATILE` function with `search_path=pg_catalog` and timezone UTC. The permission catalog remains at 33 keys. Runtime receives only `EXECUTE ON FUNCTION app.client_overview(uuid,uuid)` via the reviewed grant script; it gains no direct tables or private helper grants. The definer composes guarded finance/activity readers as its owner.

Apply migration 14 before starting the new API and grant the new entrypoint. Down takes the exclusive lifecycle lock and removes only that function/index, preserving populated task, reminder, financial, pricing and audit history. Reapplying requires regranting runtime EXECUTE. Older historical migrations retain their own populated rollback protections.

## Verification

Nine real-PostgreSQL overview tests cover all 16 module-grant combinations, missing/foreign/disabled access, independent activity source grants, deadline/UUID and exact horizon boundaries, all six currencies and totals above int64, cancelled payments, immutable pricing copies, safe fields, no read audit writes, one measured runtime statement, queued revocation/disable/archive/cancellation, least-privileged runtime execution and populated migration down/up. The complete backend race suite, vet/build and migration regressions also apply. Local database proof uses disposable PostgreSQL 17.11; final-head CI supplies PostgreSQL 18 and existing container/browser gates. UI request counts, responsive layouts and accessibility remain frontend acceptance work.
