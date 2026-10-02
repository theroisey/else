# One-time client reminder API

Related Issue: [#18](https://github.com/theroisey/else/issues/18). The [implementation contract](https://github.com/theroisey/else/issues/18#issuecomment-5948078773) and [timezone compatibility clarification](https://github.com/theroisey/else/issues/18#issuecomment-5948636628) were recorded before the corresponding implementation. This backend slice provides stored schedules and explicit lifecycle; the separately reviewed frontend follows owner merge. Issue #18 remains open until its interface is delivered.

## Authorization and historical ownership

Every read requires effective `reminders.view` for the exact client. Every write also requires `reminders.create` or `reminders.update`, as appropriate. Authorship and ownership never grant access. There is no legacy aggregate permission. Migration 000009 adds these three definitions and seed links only to Initial Administrator; the current catalog contains 29 keys. Custom roles retain their existing grants. The frontend known-key map recognizes the additions for identity and administration compatibility without introducing reminder screens.

Creation defaults an omitted owner to the authenticated actor. New or changed owners must be active users with effective reminder view in this client. Existing ownership can be retained after disabling the owner or revoking their access: history is not silently reassigned. The bounded owner directory returns only IDs and display names, requires reminder view plus create or update, and is unavailable for archived clients. Reminder reads contain owner IDs, not an expanded directory entry.

All writes require an active client. Archived-client records remain readable under current reminder view. Server-owned fields include client, creator, record ID, revision, status and lifecycle timestamps. No owner/creator exception bypasses current permission checks.

## Schedule and DST contract

Every metadata request supplies a wall clock `scheduled_local`, a named IANA `timezone`, and an explicit integer `utc_offset_seconds`, including zero for UTC. Wall clocks use `YYYY-MM-DDTHH:mm:ss` with optional one to six fractional digits; they contain no zone suffix. Both local and UTC years must be 0001–9999. Named zones such as `America/New_York`, `Asia/Kathmandu` and `UTC` are supported; `Local`, unknown zones and textual fixed offsets are rejected.

The API computes `scheduled_at` in UTC and verifies that the chosen zone at that instant has the supplied offset and round-trips to the requested wall clock. The guarded SQL writer repeats validation. Missing offsets, spring gaps, skipped dates, invalid calendars, leap seconds, precision beyond microseconds and inconsistent offsets fail with `invalid_schedule`. Past schedules are valid and become due immediately.

For New York on 2026-11-01, `01:30:00` with offset `-14400` selects `05:30:00Z`; offset `-18000` selects `06:30:00Z`. Both are valid choices. New York `2026-03-08T02:30:00` is nonexistent and rejected. Non-hour and historical second offsets are supported. Consumers must ask for a repeated-hour choice rather than silently select an occurrence.

Storage retains the computed UTC instant, canonical original wall clock, named zone and selected offset. An arithmetic constraint preserves consistency independently of mutable IANA rules. New schedules and full metadata replacements require agreement with the current Go and PostgreSQL zone rules; disagreements fail safely for user review. Completion and dismissal preserve the recorded instant and original intent even if rules later change. Existing schedules are never automatically reinterpreted or moved. Go embeds tzdata so minimal runtime images do not depend on an OS timezone directory.

## Endpoints

All paths are rooted at `/api/v1/clients/:client_id/reminders`. Requests use the existing same-origin cookie session, CSRF header and Origin checks. Responses are `no-store`; writes have a strict 64 KiB JSON decoder, reject unknown fields and trailing JSON, and return the existing safe error envelope.

| Method | Path suffix | Result |
| --- | --- | --- |
| GET | empty | Bounded reminder summaries |
| GET | `/owners` | Bounded eligible owner IDs/display names |
| GET | `/:id` | Reminder detail, including description |
| POST | empty | Create pending reminder, HTTP 201 |
| PUT | `/:id` | Replace metadata of a pending reminder |
| POST | `/:id/complete` | Complete pending reminder |
| POST | `/:id/dismiss` | Confirm and dismiss pending reminder |

Example creation with synthetic IDs:

```json
{
  "title": "Review the client plan",
  "description": "Check the recorded milestone dates.",
  "owner_id": "11111111-1111-4111-8111-111111111111",
  "scheduled_local": "2026-11-01T01:30:00.123456",
  "timezone": "America/New_York",
  "utc_offset_seconds": -18000,
  "resource": null
}
```

Writes return `{"data":{"id":"uuid","revision":1}}`; subsequent writes increment the revision exactly once. PUT accepts the complete creation metadata plus `expected_revision`; its owner is required. Omitting/nulling `resource` clears the optional reference. Completion accepts `{"expected_revision":1}`. Dismissal additionally requires `"confirm":true`.

Summary fields are `id`, `client_id`, `created_by`, `owner_id`, `title`, `status`, `scheduled_at`, `scheduled_local`, `timezone`, `utc_offset_seconds`, `resource`, `is_due`, `completed_at`, `dismissed_at`, `revision`, `created_at` and `updated_at`. Detail adds `description`. UTC timestamp responses preserve available microseconds. Terminal timestamps are null while pending. Detail responses wrap the record in `data`; pages contain `data` and `page:{limit,next_cursor}`.

## Lifecycle and bounded views

The only transitions are pending → completed and pending → dismissed. Terminal records remain readable and immutable; there is no reopening, archival or deletion endpoint. Timestamps come from the server. A due reminder is pending with `scheduled_at <=` the database statement time. Completion/dismissal removes it from due/upcoming views regardless of its schedule.

Lists default to 25 records, `status=pending`, `due=all`, `owner=any`, `sort=id`. Supported query parameters are:

| Parameter | Values |
| --- | --- |
| `limit` | Integer 1–100 |
| `cursor` | Last returned nonzero UUID |
| `status` | `pending`, `completed`, `dismissed`, `all` |
| `due` | `all`, `due`, `upcoming`; due/upcoming always require pending state |
| `owner` | `any`, `me`, or nonzero owner UUID, including historical owners |
| `q` | Literal title substring, at most 100 characters; percent/underscore are not wildcards |
| `sort` | `id` or `-id` |

Owners accept only `limit` and `cursor`, ordered by ascending UUID. Unknown, empty or duplicate query values are invalid. There are no unbounded responses or fabricated total counts. Cursor pagination is not a snapshot; restart paging when filters or sort change.

## Optional resource references

`resource` is null or `{"kind":"task|plan|milestone","id":"uuid"}`. New/changed references require independent `tasks.view` or `planning.view` and a nonarchived target in this exact client. Milestones additionally require a nonarchived parent plan. Completed/cancelled resource state does not determine reminder state or prevent an otherwise eligible link.

Unchanged historical references remain retainable after independent read revocation or resource archival. Clearing a reference requires reminder update only; relinking checks current eligibility again. Read responses expose reference IDs only, never linked titles, descriptions or other protected metadata. Composite foreign keys independently enforce client isolation and the milestone parent/client relationship.

## Conflicts and failures

Invalid requests, owners, links and schedules return HTTP 400 with their specific safe error code. Missing or unauthorized records return 404 without distinguishing their existence. Stale revisions, terminal writes and archived-client writes return 409 `conflict`; consumers must reload current data explicitly and preserve an unsaved draft until that choice. Unsupported methods return 405. Session/CSRF failures use the existing identity contract. Internal errors log request ID and a fixed error code, never reminder text or raw database errors.

## Atomic audit and notification seam

Each successful create, metadata replacement, completion or dismissal commits exactly one corresponding `reminder.created`, `.updated`, `.completed` or `.dismissed` event in the mutation transaction. Audit failure rolls the record change back. Snapshots contain only typed `exists`, `revision`, `reminder_status`, `reminder_scheduled_at` in UTC and `reminder_timezone`. They exclude title, description, original wall clock, offset, owner and reference IDs. Existing task/planning snapshots and action semantics remain intact.

Reminder writes acquire authorization transaction lock `871092650209` before fresh actor, permission, client, owner, target revision and changed-resource checks. Guarded writes are VOLATILE so checks see commits that occurred during the lock wait. Storage, schedule validators and unchecked document/snapshot helpers remain private; the runtime role receives only reviewed guarded functions.

The service commit boundary is the future notification/outbox adapter seam. A later delivery slice must enqueue transactionally and dispatch after commit, independently checking transport policy and recording actual delivery results. This slice wires no sender, worker, polling scheduler or delivery status. Due means schedule eligibility only. Recurrence and notification delivery remain later work.

## Migration and operational compatibility

Drain writes, apply owner migration 000009, reapply the reviewed grants in `backend/scripts/grant-runtime.sql` to the environment's runtime role, then start the new API. The HTTP process performs no DDL. Use explicit operational lock/statement timeouts and stop rather than force a migration through active writers. Reapply runtime grants after function recreation on an unused down/up cycle.

The additive upgrade preserves populated identity/client/task/planning/link/audit history. Down is permitted only when reminder storage, reminder audit history and nondefault/revoked reminder grant history are empty. It refuses terminal rows as well as pending rows, audit-only history, custom grants and revoked seed grants. A refused rollback is transactional and leaves schema version 9 intact. An unused rollback restores migration 8's audit validation and removes only the three new definitions/default seed links.

Verification includes ordinary and non-hour DST folds/gaps, skipped dates, precision/calendar bounds, explicit-offset policy, owner eligibility and retention, resource isolation/privacy/retention, actual due/terminal filters, strict HTTP boundaries, private SQL helpers, atomic audit failure, concurrent revisions, twelve lock-wait scenarios and populated rollback refusal. The complete Go race suite and existing seven real-API browser flows protect previous modules; frontend lint/typecheck, 127 tests, production build and production dependency audit also pass. Local PostgreSQL 17.11 uses disposable synthetic fixtures; PR CI verifies PostgreSQL 18 and containers before readiness. No production migration or deployment is performed by this slice.
