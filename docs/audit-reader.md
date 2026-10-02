# Authorized audit-read API

Issue [#28](https://github.com/theroisey/else/issues/28) starts with a separately reviewed backend slice after owner-merged activity interface [#57](https://github.com/theroisey/else/pull/57) at `1a30014`. Both development branches were synchronized. Main [run 37011258324](https://github.com/theroisey/else/actions/runs/37011258324) passed all five gates and tested-image publication. The [policy contract](https://github.com/theroisey/else/issues/28#issuecomment-5953240480) preceded implementation. Owner-merged [API PR #58](https://github.com/theroisey/else/pull/58) at `45db4b1` passed all five main gates and publication in [run 37016592527](https://github.com/theroisey/else/actions/runs/37016592527). Its separately reviewed [frontend table and accessible detail/difference panel](audit-interface.md) consume this contract; owner frontend merge completes #28.

## Routes and visibility

| GET route | Access and result |
| --- | --- |
| `/api/v1/audit-logs` | Current global `audit.view`; bounded visible summaries |
| `/api/v1/audit-logs/:eventID` | Same global capability; one visible detail |
| `/api/v1/clients/:clientID/audit-logs` | Global `audit.view` plus current `clients.view` for a real exact client |
| `/api/v1/clients/:clientID/audit-logs/:eventID` | Same client policy; event must belong to this exact client |

The existing `audit.view` key remains **global-only**. A role assigned at client scope cannot confer its global capabilities. No permission catalog, role seed, ownership or authorship exception is added. `activity.view` and related domain view grants do not confer audit access.

Global events (`client_id: null`) are visible with global audit access. Client-linked events additionally require a real client and its current `clients.view`, including an applicable global client-view grant. Scope-only/orphan identifiers do not expose history. A global audit-only viewer sees global security history, without enumerating client-linked events. Archived clients retain readable audit history. Safe cross-domain markers inside visible clients are deliberately authorized by the audit capability; this privilege is distinct from the independently filtered business activity feed.

Each database statement repeats active-user and current grant/assignment checks. Revoked client access removes list rows and detail access on the next read. Revoked global audit access and disabled users lose the reader. Actor/resource IDs remain historical references; profiles, names and directory records are never joined.

No session is 401. Missing global audit permission is 403 for global list/detail. Client routes, inaccessible selected-client filters and absent/inaccessible event IDs use uniform 404 after applicable root checks. Malformed input is 400. Database/privilege failures produce safe 500 responses and logs without SQL, IDs, filters, tokens or driver causes. All responses use `Cache-Control: no-store`. Other authenticated methods return 405 with `Allow: GET`; HEAD omits its body. Reads need no mutation CSRF token.

## Summary and detail projections

Lists return `{data: [...], page: {limit: 25, next_cursor: null}}`, including `data: []` for a permitted empty page. Each summary contains exactly:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "schema_version": 1,
  "occurred_at": "2026-10-02T12:00:00.123456Z",
  "actor_kind": "user",
  "actor_user_id": "22222222-2222-4222-8222-222222222222",
  "event_type": "task.updated",
  "resource_kind": "task",
  "resource_id": "33333333-3333-4333-8333-333333333333",
  "client_id": "44444444-4444-4444-8444-444444444444",
  "request_id": "AAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

IDs above are synthetic examples. System actors have null `actor_user_id`; global events have null `client_id`. The recorded request ID differs from the server-owned X-Request-ID of the current read. UTC timestamps retain microseconds. Only schema-version-1 events and reviewed action syntax are supported; no labels or events are inferred from current resource state.

Detail returns `{data: {...summary, before_state, after_state, metadata}}`. Snapshots are null or objects containing only present reviewed markers:

| Marker | Safe read representation |
| --- | --- |
| `exists` | Boolean |
| `revision` | Canonical decimal **string**, 0–9223372036854775807; preserves full int64 in JavaScript |
| `status` | `active` or `disabled` |
| `task_status` | Reviewed task state, only for tasks |
| `planning_status` | Reviewed plan/milestone state, only for those resources |
| `reminder_status` | `pending`, `completed`, `dismissed`, only for reminders |
| `reminder_scheduled_at`, `reminder_timezone` | Paired reviewed UTC instant/named zone for reminders |

`metadata` is exactly `{source: "http" | "job" | "cli"}`. Typed output validation enforces kind/state/time/precision relationships. The SQL projector explicitly selects these snapshot keys; a future storage allowlist expansion cannot silently expand the read DTO. Summaries omit all snapshots and metadata. Never return titles, descriptions, profile/contact/tag values, actor names/emails, credentials, passwords, token/hash values, raw DTOs, IP/user-agent or unreviewed metadata. The [frontend](audit-interface.md) computes readable differences from this finite detail contract; unchanged markers are not invented changes. Preserve null versus empty snapshots and exact revision strings.

## Bounded filters and chronological pages

Lists accept these exact optional parameters, once each and nonempty:

- `limit`: default 25, 1–100. No totals or offsets.
- `actor_id`: nonzero user UUID; `actor_kind`: `user` or `system`.
- `event_type`: reviewed `<resource>.<action>` syntax; `resource_kind`: lowercase bounded kind; `resource_id`: nonzero UUID.
- `client_id`: nonzero UUID on the global collection only; it requires actual current client visibility. Client routes take their client from the path and reject this query parameter.
- `request_id`: exact 26-character uppercase base32 recorded correlation ID.
- `from`, `to`: UTC RFC3339 dates, four-digit years 0001–9999 and at most six fractional digits. From is inclusive, to exclusive; a supplied pair must increase.
- `cursor`: unchanged opaque continuation, maximum 256 characters.

Reject unknown/duplicate/empty parameters, malformed percent encoding and raw queries over 2048 characters. IDs normalize to lowercase and dates to UTC before query/cursor binding. Detail rejects all query parameters. Filtering is exact, with no free-text profile search or SQL interpolation.

Order by `(occurred_at DESC, id DESC)` and fetch at most `limit + 1` to determine continuation. The canonical unpadded base64url cursor contains version, SHA-256 fingerprint of normalized route/filters, exact UTC boundary and event ID. It binds all filters and route context, but not page size. It is untrusted ordering input, not an authorization token or signed credential. No boundary-event lookup occurs; a valid cursor remains usable when its original row's client access is revoked. Changing route/filters requires restarting pagination.

Every page uses current policy and one database statement snapshot, not a snapshot spanning requests. Newer commits above the boundary appear after first-page refresh. Late commits with older timestamps can appear on later pages. Filter/client visibility scans may examine more rows than the page size; a five-second service deadline bounds database work and inherits earlier request cancellation. Existing client/actor/resource/request indexes and the new global chronological index support reads; production workload evidence and additional justified indexes remain separate performance work.

## Storage, read logging and rollout

Migration `000011_create_audit_reader.sql` adds two STABLE SECURITY DEFINER readers with fixed `pg_catalog` search paths, a private immutable snapshot projector and `audit_events_time(occurred_at DESC,id DESC)`. It changes no event, business record, permission/seed or audit payload policy. The runtime receives EXECUTE only on the two guarded readers through [explicit runtime grants](../backend/scripts/grant-runtime.sql). Raw audit SELECT/UPDATE/DELETE/TRUNCATE and unchecked projector EXECUTE remain denied; PUBLIC receives no reader capability. Append-only triggers and audited business transactions remain unchanged.

Successful/failed reads use existing safe HTTP correlation/status logging. They append no audit events, avoiding recursive read auditing, and never mutate prior history. Any later compliance policy for access-event retention requires a separately reviewed design.

Apply migration 11 with the separate migration owner and reapply reviewed runtime EXECUTE grants before starting this API. The index is transactional, not concurrent: plan for its build/storage cost and locking under the existing migration lock/statement deadlines, with an appropriate traffic drain/maintenance window. Down removes only readers/projector/index and preserves populated business, audit and grant history. Recreated functions require grant reapplication. No production migration or deployment is performed here.

## Verification

Five audit-reader unit checks and nine new PostgreSQL integration checks cover hostile filters/routes/cursors, microseconds/calendar bounds, int64 redaction, exact summary/detail fields, global/exact-client/foreign/orphan visibility, scoped global-key exclusion, independent root grants, archived history, audit/client revocation and disabled actors, 105 equal-time rows, filter/route-bound cursors, newer commits, transaction commit/rollback and failed-audit business rollback, GET-only/authentication/HTTP errors, runtime/PUBLIC denial, safe diagnostics, definer settings and populated-history migration roundtrips. A dedicated HTTP routing check verifies protected adapters and log labels.

Complete Go race/PostgreSQL regressions, Go vet/static API/migration builds, 195 existing frontend tests, lint/typecheck/production build and all nine existing real-API Chromium flows verify compatibility. Local PostgreSQL 17.11 is disposable; final-head CI verifies PostgreSQL 18, containers and browser regressions before PR readiness. Earlier-domain migration tests explicitly target their own versions; the complete empty roundtrip now includes eleven migrations. The backend slice introduced no frontend; its separate [frontend consumer](audit-interface.md) adds inspection after owner API merge.
