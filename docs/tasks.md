# Client task API

Related Issue: [#15](https://github.com/theroisey/else/issues/15). The [pre-implementation contract](https://github.com/theroisey/else/issues/15#issuecomment-5941777252) defines authorization, transitions, assignees and archival. Task UI is delivered by [#16](task-interface.md); [#17](planning.md) adds planning and historical milestone links. Comments and attachments remain later work.

## Access and retention

Tasks belong to an actual client. Reads require effective `tasks.view` for that exact client; a global assignment containing that permission qualifies. Client-profile view is an independent capability. Creation requires `tasks.create`, metadata/status changes require `tasks.update`, and archive requires `tasks.delete`. Legacy `tasks.manage` remains an aggregate for these three write operations, without granting view. Creator and assignee are historical references and never grant access.

Migration 000007 adds three client-scoped permission definitions and explicit seeded links into Initial Administrator, following the existing catalog seed convention. It does not expand custom roles, grant Finance write access, or invent historical user events for schema setup. Migration 000007 established 22 keys; planning migration 000008 raises the current catalog to 26. The frontend known-key map recognizes the three additions so the existing administration UI can manage them; task product UI follows in #16. A legacy manage holder can write tasks but still needs explicit control of a granular key to delegate that key through ordinary RBAC.

Missing/inaccessible clients, unauthorized operations and tasks belonging to another client share `404 not_found`. UUID knowledge establishes no access. A client must be active for every write. Authorized historical reads remain available after client archive.

Archive is the task deletion policy. `POST .../:taskId/archive` requires `confirm:true` and the current revision, retains task state, timestamps, tags and audit history, and blocks further writes. The API has no hard delete or restore. Cancellation is an explicit status change with its own timestamp/event, rather than archival.

## Fields and validation

Creation accepts the metadata below plus optional initial `status` (`todo` by default, or `backlog`). PUT replaces all metadata: omitted optional values become empty/null/default, and the tags replace the complete child set.

| Field | Contract |
| --- | --- |
| `title` | Required, trimmed, 1–200 Unicode characters, no control characters |
| `description` | Trimmed plain text, at most 8000 characters; CRLF becomes LF; only LF is accepted among control characters |
| `priority` | `low`, `medium`, `high`, `urgent`; omitted/empty defaults to `medium` |
| `assignee_id` | Nullable nonzero UUID; new/changed value must be an eligible assignee |
| `start_at`, `due_at` | Nullable RFC3339 timestamps with explicit timezone; normalized to UTC; due must not precede start |
| `tags` | At most 20 distinct trimmed lowercase labels, each 1–40 characters, without control characters |

Dates describe planned work; they do not trigger automatic transitions. PostgreSQL persists instants at microsecond precision. Input dates must fall within years 1–9999 after UTC conversion. Task ID, client ID, creator, revision, creation/update/archive and completion/cancellation times are server-owned. Strict JSON rejects unknown fields, trailing values and bodies over 64 KiB. Status is accepted only on create and the dedicated status endpoint.

A new or changed assignee must be an active identity holding effective `tasks.view` for this client. Missing, disabled, revoked and foreign-client candidates all yield `400 invalid_assignee`. Existing unchanged references survive disable/revocation and can remain on metadata/status changes. An authorized editor can explicitly clear or replace them. The picker excludes historical ineligible users; consumers should display an unavailable former assignee without automatically clearing their ID.

## State transitions

| Current status | Allowed next statuses |
| --- | --- |
| `backlog` | `todo`, `cancelled` |
| `todo` | `backlog`, `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `todo`, `blocked`, `review`, `done`, `cancelled` |
| `blocked` | `todo`, `in_progress`, `cancelled` |
| `review` | `in_progress`, `blocked`, `done`, `cancelled` |
| `done` | `in_progress` |
| `cancelled` | `backlog`, `todo` |

Self transitions and all omitted edges return `409 invalid_transition` without changing data, revision or audit history. Entering done sets server `completed_at`; leaving done clears it. Cancellation sets `cancelled_at`, cleared on reopening. Done/cancelled tasks require an explicit reopen before metadata changes. Every successful write increments revision exactly once; create starts at one. Stale revision, archived task/client or terminal metadata edit returns `409 conflict` and requires reloading/reviewing current data.

## HTTP contract

Existing same-origin cookies, authentication, no-store responses, request IDs, JSON error envelopes and mutation Origin/CSRF checks apply. Base path: `/api/v1/clients/:clientId/tasks`.

| Method/path | Input | Result |
| --- | --- | --- |
| GET base | List query below | `{data: Summary[], page: {limit, next_cursor}}` |
| POST base | Metadata plus optional initial status | 201 `{data: {id, revision: 1}}` |
| GET `/:taskId` | No query | `{data: Task}` |
| PUT `/:taskId` | Complete metadata plus `expected_revision` | `{data: {id, revision}}` |
| POST `/:taskId/status` | `{status, expected_revision}` | `{data: {id, revision}}` |
| POST `/:taskId/archive` | `{confirm: true, expected_revision}` | `{data: {id, revision}}` |
| GET `/assignees` | `limit`, `cursor` only | `{data: [{id, display_name}], page: {limit, next_cursor}}` |

Summary contains `id`, `client_id`, `created_by`, nullable `assignee_id`, title, status, priority, nullable start/due/completed/cancelled/archive timestamps, revision, tags, and created/updated timestamps. Detail adds `description`. Times serialize as RFC3339 UTC; nullable fields serialize as JSON null. Collections never expose hidden totals. Mutation responses deliberately contain only ID/revision; authorized readers reload detail.

The assignee picker requires view **and** create/update/manage for the active client. It returns only eligible IDs and display names, filtering before pagination. It exposes no email, role, hash or unrestricted user directory. Archived clients return conflict. The picker is optional discovery; the authoritative eligibility check runs again inside each write.

### List query

| Key | Accepted values/default |
| --- | --- |
| `limit` | Integer 1–100, default 25 |
| `cursor` | Nonzero UUID of the previous page's final record |
| `sort` | `id` (default), `-id` |
| `status` | Any of the seven states, or `all` (default) |
| `priority` | Any of the four priorities, or `all` (default) |
| `assignee` | UUID, or `unassigned`; omitted means any assignee |
| `q` | Trimmed literal case-insensitive title substring, ≤100 characters |
| `tag` | Exact normalized lowercase tag, ≤40 characters |
| `archived` | `false` (default), `true`, `all` |

UUID keysets provide stable ordering, independent of mutable titles and state; they do not imply creation-time order. The server fetches one extra authorized match to produce `next_cursor`, otherwise null. Reset cursors when changing filters. Unknown, duplicate, empty or malformed query values fail with `400 invalid_request`. Detail and all mutation routes accept no query parameters.

## Audit and persistence

Service writes and audit insertion share the mandatory correlated transaction. Create emits `task.created`; metadata and ordinary/reopen transitions emit `task.updated`; entering done emits `task.completed`; entering cancelled emits `task.cancelled`; archival emits `task.archived`. Each event records authenticated actor, task UUID and exact client UUID. Before/after snapshots contain existence, revision and allowlisted `task_status`; no title, description, tag, assignee or personal contact value enters audit/log payloads. Creation has a null before snapshot; archive retains existence/state. Both Go and SQL restrict the new state marker and completion/cancellation actions to task resources. Existing user status remains `active`/`disabled`.

Migration 000007 creates tasks and normalized task tags with restrictive client/user foreign keys, state/priority/date/timestamp checks, positive revisions, and active/archived client keysets plus status/assignee/tag indexes. Runtime receives only reviewed EXECUTE on `task_read`, `task_list`, `task_assignees`, `task_write`; tables and unchecked document/authorization/transition helpers stay private. Security-definer functions use fixed `pg_catalog` search paths.

Task writes take the existing authorization transaction lock before checking the actor, active parent and a changed assignee. Their VOLATILE reads observe newly committed permission revocation, disabled users and client archival after waiting. Concurrent edits also compare the locked task revision. An audit insert failure rolls back task metadata, status/timestamps, tags and revisions together.

## Migration rollout and verification

Apply owner migration 000007 before starting the API. Reapply reviewed runtime grants from `backend/scripts/grant-runtime.sql` for the environment's own runtime role. Existing identity/admin/client data and events are preserved. Follow the established migration command timeout/DDL lock timeout and maintenance guidance; the audit constraint changes can briefly lock append activity. Drain application writers during migration/rollback and stop on a lock timeout, then retry in the approved maintenance window. No application startup performs DDL.

Down refuses any task rows, task audit history, or non-default/revoked links for the three new permission keys. Only untouched seeded Initial Administrator links may be removed. It never deletes task or audit history to permit rollback. An unused task migration can roll back while preserving populated clients and previous permission/audit history; empty complete up/down/up also passes. Reapply runtime grants after up/down/up. Applied migrations are immutable after merge.

Local verification uses PostgreSQL 17.11 and race-enabled real HTTP/service integration tests: all 49 state pairs, timestamp reopening, scoped/granular/legacy permissions, assignee filtering/replacement/history, pagination/filters, authentication/CSRF/strict bodies, audit rollback, private storage, concurrent revisions and four lock-wait boundary races. Migration tests cover old-data preservation, complete empty round-trip and task/audit-only/revoked-permission rollback refusal. Frontend lint/typecheck/build, 72 tests, and all five existing real-API browser flows pass. CI additionally verifies the repository-pinned PostgreSQL 18, browser and containers before review.
