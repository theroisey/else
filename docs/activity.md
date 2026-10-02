# Client activity API

Issue [#22](https://github.com/theroisey/else/issues/22) begins with a separately reviewed backend slice after owner-merged reminder interface [#55](https://github.com/theroisey/else/pull/55) at `0194e8c`. Both development branches were synchronized; [main run 37001360296](https://github.com/theroisey/else/actions/runs/37001360296) passed all five gates and tested-image publication. The [contract](https://github.com/theroisey/else/issues/22#issuecomment-5951504480) preceded implementation. The activity timeline follows owner review/merge of this API; #22 stays open for that consumer.

## Read contract

`GET /api/v1/clients/:clientID/activity` uses the existing cookie-session adapter and returns `Cache-Control: no-store`. Require current exact-client `activity.view` **and** `clients.view`, including valid global assignments that satisfy client capabilities. Missing/inaccessible clients share HTTP 404 `not_found`. Ownership, authorship and `audit.view` confer no activity access. Disabled users and revoked assignments lose access on the next read. Archived clients remain readable; activity does not permit mutations.

Only GET is supported. Other authenticated methods return 405 with `Allow: GET`; HEAD omits the response body. Reads need no mutation CSRF token. Invalid route/query/cursor inputs return 400 `invalid_request`; database failures return a safe 500 `internal_error`. Correlation IDs remain in the standard error envelope and safe logs, never in successful activity rows.

The successful response contains exactly these projected row fields:

```json
{
  "data": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "client_id": "22222222-2222-4222-8222-222222222222",
      "occurred_at": "2026-10-02T12:00:00.123456Z",
      "event_type": "task.completed",
      "resource_kind": "task",
      "resource_id": "33333333-3333-4333-8333-333333333333",
      "summary": "Task completed."
    }
  ],
  "page": { "limit": 25, "next_cursor": null }
}
```

UUIDs above are synthetic contract examples. `data` is an array, including `[]` for an authorized empty page. `summary` comes from a server-owned English label allowlist; it never interpolates user-entered text. Timestamps are UTC and retain stored microseconds.

## Inclusion and redaction

| Resource | Included event actions | Additional current read permission |
| --- | --- | --- |
| Client | created, updated, archived | Root client/activity permissions |
| Task | created, updated, archived, completed, cancelled | `tasks.view` for this client |
| Plan | created, updated, archived | `planning.view` for this client |
| Milestone | created, updated, archived | `planning.view` for this client |
| Reminder | created, updated, completed, dismissed | `reminders.view` for this client |

Project only schema-version-1 persisted events for this exact client. Authentication, users, roles, assignments, global events, unknown kinds/actions and unsupported deletes are excluded. A plan reaching terminal state through its existing update endpoint remains "Plan updated."; activity does not invent a completion event. A reopened task retains its earlier "Task completed." event alongside later updates.

No actor identities/names, titles, contacts, descriptions, before/after snapshots, revisions, owner/resource links, reminder schedules/timezones, request IDs or source metadata appear. No joins to current user/resource profiles occur. Archived resources and old event IDs remain visible while the current client/domain read grants permit them. Resource IDs establish references only; a milestone row provides no parent-plan ID or resource metadata. Consumers must independently authorize any resource lookup or link.

## Chronological pagination

Allow only `limit` and `cursor`, once each and with nonempty values. Default limit is 25, maximum 100. Raw query length is bounded; unknown filters, offsets, duplicates and malformed encoding fail. Query at most `limit + 1` eligible rows to determine continuation; return no totals.

Order by `(occurred_at DESC, id DESC)`. Equal timestamps use the UUID tie-breaker. `next_cursor` is a versioned, canonical, unpadded base64url encoding of `v1|clientID|UTC timestamp|eventID` for the last returned row. Timestamp precision is at most microseconds, years 0001–9999, and the client must match the route. The maximum encoded cursor length is 256 characters. Treat it as opaque in consumers and use it unchanged for the next request.

The cursor is an unsigned, untrusted ordering boundary, never an authorization token. No event lookup is needed, so guessed event IDs disclose no existence and a cursor survives revocation of its original row's domain. Every page uses current permissions and the database statement's consistent snapshot. This is not a cross-request snapshot: newer commits above the boundary appear after refreshing the first page; a transaction that commits an older event timestamp later can appear on a later page. Refresh after access changes to review the current visible feed.

## Storage and deployment

Migration `000010_create_activity.sql` adds client-scoped `activity.view` (30 known keys), explicitly seeding Initial Administrator only. Custom roles, Finance and Viewer do not expand automatically. The only frontend change in this backend slice recognizes the new key for existing identity/administration compatibility; no activity product page is introduced.

One STABLE SECURITY DEFINER reader performs all current capability checks with fixed `pg_catalog` search path and an explicit column/action allowlist. It reuses `audit_events_client_time` for reverse keyset reads. Runtime receives EXECUTE on `app.activity_list(uuid,uuid,timestamptz,uuid,integer)`; it receives no audit SELECT or unchecked projection helper. Existing append-only audit restrictions and mutation transactions remain intact. Reads create no new audit events.

There is no projection table, backfill, worker, copied history or eventual-consistency lag. Only committed business/audit events are visible. Failed audited business writes and rolled-back/uncommitted events cannot appear.

Apply migration 10 through the environment's migration owner, then reapply [reviewed runtime grants](../backend/scripts/grant-runtime.sql) before serving the new API. Down removes only the reader and unused seed/catalog key, preserving all existing business/audit history. It refuses custom or revoked activity grant history and leaves version 10 unchanged on refusal. Use the existing operational lock/statement deadlines and drain affected traffic for migration DDL; recreated functions need explicit runtime grant reapplication. No production migration or deployment is performed by this slice.

## Verification

Coverage includes all 18 lifecycle labels through real business writes, exact response redaction, independent domain visibility, global/exact-client denial, archived history, revocation/disablement, equal-time 105-row pagination, concurrent newer inserts, nonexistent cursor boundaries, commit/rollback visibility, failed-audit rollback, hostile inputs, GET-only/authentication behavior, runtime/PUBLIC privilege boundaries, definer settings and populated-history migration roundtrips/refusal.

Local verification passes complete Go race/integration tests on disposable PostgreSQL 17.11, the added lifecycle check, Go vet, static API/migration builds, 159 frontend tests, lint/typecheck/build, production dependency audit with zero vulnerabilities, and all eight existing real-API Chromium flows. Existing migration tests explicitly target earlier domain versions while checking the current 30-key catalog. Final-head CI verifies PostgreSQL 18, containers and browser regressions before PR readiness. Local Docker checks are not run.
