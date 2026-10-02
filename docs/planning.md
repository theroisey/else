# Client planning API

Related Issue: [#17](https://github.com/theroisey/else/issues/17). The [recorded implementation contract](https://github.com/theroisey/else/issues/17#issuecomment-5945928902) settles access, lifecycle, link retention and rollback before implementation. Backend PR #52 is owner-merged at `b7b7e95`. The separately reviewed [frontend interface](planning-interface.md) consumes this contract and closes #17 after owner merge.

## Ownership and access

A plan permanently belongs to an actual client; a milestone permanently belongs to that plan and client. Authenticated `created_by` is immutable historical authorship. It grants no access and cannot be assigned or changed. There is no planning owner picker or general user directory.

Every read requires effective `planning.view` for the exact client. Every write additionally requires its own capability: `planning.create` for plans/milestones, `planning.update` for metadata/status/task links, or `planning.archive` for confirmed archival. Global assignments containing the client-scoped capability qualify; another client's assignments do not. Client-profile and task permissions are independent. There is no legacy aggregate planning permission.

Migration 000008 adds these four client-scoped definitions and explicit seed links only to Initial Administrator. It does not expand custom roles. Identity/catalog now expose 26 keys; the frontend known-key map recognizes the additions so existing sessions and administration continue to work. The separately reviewed [planning interface](planning-interface.md) provides the product screens.

Inaccessible, missing and foreign-client records return the same `404 not_found`. Reads preserve history after client, plan or milestone archival. Every write requires an active client, an unarchived target and, for milestones, an unarchived nonterminal parent plan. A plan archive retains children and links without rewriting their state/revisions. There is no hard delete, restore, automatic progress, scheduling or task-state mutation.

## Metadata and lifecycle

Plans accept required trimmed `title` (1–200 Unicode characters), trimmed plain-text `description` (at most 8000 characters; CRLF normalizes to LF), and nullable `start_at`/`due_at`. Milestones accept the same text and nullable `due_at`, with no start field. Only LF is allowed among description control characters; titles allow none. Full PUT replaces metadata; omitted optional values clear them. IDs, parents, creator, revision and lifecycle timestamps are server-owned and rejected as input.

Dates accept timezone-explicit RFC3339 instants, normalized to UTC microseconds in years 1–9999. A plan's due date cannot precede its start. Every nonarchived milestone due date must lie within each supplied plan boundary, inclusively. A plan date edit rechecks existing nonarchived milestones under the writer lock. Archived milestone dates remain historical. Invalid windows return `400 invalid_dates` without changes.

| Plan state | Allowed next states |
| --- | --- |
| `draft` (initial) | `active`, `cancelled` |
| `active` | `draft`, `completed`, `cancelled` |
| `completed` | `active` |
| `cancelled` | `draft`, `active` |

| Milestone state | Allowed next states |
| --- | --- |
| `planned` (initial) | `in_progress`, `completed`, `cancelled` |
| `in_progress` | `planned`, `completed`, `cancelled` |
| `completed` | `in_progress` |
| `cancelled` | `planned`, `in_progress` |

Self transitions and omitted edges return `409 invalid_transition`. Server `completed_at`/`cancelled_at` follow the target state and clear on reopening. Terminal metadata and link changes require an explicit reopen. Completing a plan is manual and does not inspect or change milestone/task progress. Parent terminal state prevents all child writes, including child archive; reopen the parent first. Archival of the target itself remains available with its archive capability and confirmation.

Successful creation starts at revision one. Every subsequent mutation compares `expected_revision` and increments the target once. Milestone writes do not increment their parent. Stale revisions, archived records/parents/clients and terminal metadata/link edits return `409 conflict`; reload and review current data before retrying.

## Historical task links

Only milestones link tasks. A task may link to multiple milestones, but active duplicates within one milestone are forbidden. Composite foreign keys enforce milestone/plan/client and task/client consistency.

`PUT .../:milestoneId/task-links` replaces the complete active set with at most 50 distinct nonzero task UUIDs and the current milestone revision. `task_ids` must be an array; `[]` explicitly clears it. Missing/null, duplicates and oversized sets return `400 invalid_request`. Removed rows receive server `unlinked_at`; relinking creates a new row, retaining previous history.

New links additionally require active same-client tasks and effective `tasks.view` for this client; foreign, missing, archived or inaccessible candidates share `400 invalid_task_link`. Unchanged active references remain valid after task archival or task-view revocation. An editor can retain or explicitly remove them using planning permissions alone. Removed historical references become new links if selected again and must pass current eligibility checks.

Planning detail exposes only the bounded active `task_ids`. Paged link reads expose link ID, task ID, `linked_at` and nullable `unlinked_at`; they never expose task title, status or other task metadata. A link does not grant task access. Consumers need independent task authorization for further details.

The candidate endpoint requires planning view, planning create or update, and task view for the active client and nonterminal active plan. It returns only active same-client task ID/title/status, filtered before pagination. Task state does not determine link eligibility. Selection is discovery; the write repeats current checks after locking.

## HTTP contract

Existing cookie authentication, mutation Origin/CSRF checks, no-store responses, request IDs and safe JSON errors apply. Bodies are limited to 64 KiB; unknown fields and trailing JSON are rejected. Detail and mutation endpoints accept no query. Base path: `/api/v1/clients/:clientId/plans`.

| Method/path | Input | Result |
| --- | --- | --- |
| GET base | List filters | `{data: Summary[], page: {limit, next_cursor}}` |
| POST base | Plan metadata | 201 `{data: {id, revision: 1}}` |
| GET `/:planId` | No query | `{data: Record}` |
| PUT `/:planId` | Complete metadata + `expected_revision` | `{data: {id, revision}}` |
| POST `/:planId/status` | `{status, expected_revision}` | `{data: {id, revision}}` |
| POST `/:planId/archive` | `{confirm: true, expected_revision}` | `{data: {id, revision}}` |
| GET `/:planId/milestones` | List filters | Paged milestone summaries |
| POST `/:planId/milestones` | Milestone metadata | 201 ID/revision |
| GET `/:planId/milestones/:milestoneId` | No query | Milestone record with bounded active `task_ids` |
| PUT `/:planId/milestones/:milestoneId` | Complete milestone metadata + `expected_revision` | ID/revision |
| POST `/:planId/milestones/:milestoneId/status` | `{status, expected_revision}` | ID/revision |
| POST `/:planId/milestones/:milestoneId/archive` | `{confirm: true, expected_revision}` | ID/revision |
| GET `/:planId/milestones/:milestoneId/task-links` | Paging and `archived` | Paged link history |
| PUT `/:planId/milestones/:milestoneId/task-links` | `{task_ids: UUID[], expected_revision}` | ID/revision |
| GET `/:planId/task-candidates` | Paging and `q` | Paged `{id, title, status}` |

Summary contains ID, client ID, creator, title, status, revision and create/update/start/due/complete/cancel/archive timestamps. Milestones additionally contain `plan_id` and serialize common `start_at` as null. Record adds description; a plan record never embeds milestones or tasks. Nullable dates serialize as null, UTC dates as RFC3339. There are no hidden totals or unbounded children.

All collections use UUID keysets: `limit` 1–100 (default 25), optional nonzero UUID `cursor`, and `sort=id` (default) or `-id`. Plan/milestone lists additionally accept their own `status` or `all` (default), `archived=false` (default)/`true`/`all`, and `q` as a trimmed literal case-insensitive title substring of at most 100 characters. Task candidates accept `q`; task-link `archived` filters by unlinking rather than task archival. Unknown, duplicate, empty and malformed query values fail. Reset cursors after filter changes.

## Transactions, runtime grants and audit

Guarded security-definer functions use fixed `pg_catalog` search paths. Runtime receives EXECUTE only on `planning_read`, `planning_list`, `planning_links`, `planning_task_candidates` and `planning_write`. Tables and unchecked document/transition helpers remain private.

Writes take authorization transaction lock `871092650209` before fresh actor, permissions, client/parent lifecycle, target revision, date-window and changed-task checks. Parent/target rows are locked in order. VOLATILE guarded writes observe changes committed while waiting, including revocation, disabling, archival, parent completion and narrowed date windows. Concurrent target edits commit one revision and one event.

The correlated service transaction inserts `plan.created`/`plan.updated`/`plan.archived` or milestone equivalents. State and link changes use `updated`. Before/after contain only existence, revision and typed resource-bound `planning_status`; creation has a null before snapshot. Text, dates, task arrays and personal information never enter snapshots or logs. Go and SQL both enforce kind-specific state allowlists. Existing user and task audit contracts retain their meaning. Audit failure rolls back metadata, timestamps, revisions and link history together.

## Rollout and verification

Apply owner migration 000008, then reapply the reviewed grants in `backend/scripts/grant-runtime.sql` for the environment's own runtime role before starting the API. No runtime DDL occurs. Existing client/task/identity/authorization records and audit events survive additive upgrade. New composite task uniqueness supports same-client links. Reapply runtime grants after an unused down/up recreation.

Drain application writers during migration/rollback; foreign-key/unique/audit constraint validation and rollback table locks can block writes. Use the established migration and DDL lock timeouts; stop on timeout and retry in the approved maintenance window. Applied migrations remain immutable after merge.

Down locks relevant tables and refuses any planning rows (including archived/unlinked history), plan/milestone audit history, or custom/revoked new permission links. Only untouched Initial Administrator seed links may be removed. An unused migration can roll down/up while preserving populated tasks/clients and previous audit/authorization history. It never erases history to make rollback succeed.

Verification covers all 32 plan/milestone state pairs, server timestamps, terminal/reopen/archive behavior, inclusive dates and historical dates, view-plus-write permissions, authorship, exact-client isolation, candidate/link paging and privacy, 50-link limits, unlink/relink history, retained archived/revoked references, atomic audit failure, private storage, concurrent revisions and eight writer-lock races. The complete race-enabled Go/PostgreSQL suite, frontend lint/typecheck/build and 101 tests, dependency audit and existing real-API browser regressions accompany this slice. CI verifies PostgreSQL 18 and containers before readiness; local PostgreSQL 17.11 uses only disposable synthetic fixtures.
