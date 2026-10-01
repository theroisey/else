# User and role administration API

Backend portion of [Issue #10](https://github.com/theroisey/else/issues/10). The frontend forms and tables follow in a separate frontend PR after this contract is merged. No administration navigation is exposed by this backend slice.

## Authentication and permissions

All routes use the existing same-origin cookie session. Reads require global `users.view` or `roles.view`; writes require global `users.manage` or `roles.manage`. Nested user-role routes use role permissions. Backend and narrow database contracts both check the current active actor. User or actor IDs in request bodies cannot override the authenticated identity.

Every mutation requires the exact configured Origin, `Content-Type: application/json`, and the session-bound CSRF header/cookie pair described in [identity](identity.md). Responses set `Cache-Control: no-store`. JSON rejects unknown fields, trailing values and bodies over 16 KiB. IDs must be canonical, nonzero UUID strings. Existing request IDs and safe error envelopes apply.

## API contract

Paths below have prefix `/api/v1`. Object reads and successful mutations return `{"data": ...}`. Collection reads return `{"data": [...], "page": {"limit": 25, "next_cursor": null}}`. Collection queries accept only `limit` (1–100, default 25) and `cursor` (the previous `next_cursor` UUID). Rows sort by immutable UUID ascending; the next cursor is the final returned ID when another row exists. Concurrent inserts before the cursor may appear only after restarting pagination. Empty collections use `[]` and a null cursor.

| Method/path | Permission | Request / response |
| --- | --- | --- |
| GET `/users` | `users.view` | Paginated users |
| GET `/users/{id}` | `users.view` | User object, or 404 |
| POST `/users` | `users.manage` | `{email, display_name, password}` → 201 `{id, revision: 1}` |
| PATCH `/users/{id}` | `users.manage` | `{email, display_name, expected_revision}` → `{id, revision}` |
| POST `/users/{id}/disable` | `users.manage` | `{expected_revision, confirm: true}` → `{id, revision}` |
| GET `/roles` | `roles.view` | Paginated roles |
| GET `/roles/{id}` | `roles.view` | Role object, or 404 |
| POST `/roles` | `roles.manage` | `{display_name, permissions: [key, ...]}` → 201 `{id, revision: 1}` |
| PUT `/roles/{id}/permissions` | `roles.manage` | `{permissions: [key, ...], expected_revision, confirm: true}` → `{id, revision}` |
| GET `/permissions` | `roles.view` | Data array of `{permission, scope, description}`; bounded catalog |
| GET `/users/{id}/roles` | `roles.view` | Paginated active assignments |
| POST `/users/{id}/roles` | `roles.manage` | `{role_id, scope, client_id?, confirm: true}` → 201 `{id}` |
| DELETE `/users/{id}/roles/{assignment_id}` | `roles.manage` | JSON `{confirm: true}` → 204 |

User fields are `id`, `email`, `display_name`, `status` (`active`/`disabled`), positive integer `revision`, `created_at`, `updated_at`, and nullable `last_login_at`. Role fields are `id`, `display_name`, `system_role`, `revision`, `permissions` (active identifier strings), `created_at`, and `updated_at`. Assignments contain `id`, `user_id`, `role_id`, role `display_name`, `scope`, nullable `client_id`, and `assigned_at`. UTC timestamps use RFC 3339. Passwords, hashes, bootstrap markers, raw session values and internal role keys are excluded.

Emails use the existing trimmed lowercase ASCII identity policy (3–254 bytes). Display names trim surrounding whitespace, require 1–100 Unicode characters, and reject control characters. Creation passwords use the existing 12–128 UTF-8 byte policy and Argon2id hashing. New users are active, have no roles and cannot bootstrap. This slice has no password reset, reactivation or hard deletion. Profile edits retain account status. Permission lists contain 1–100 known distinct identifiers. Built-in role definitions are read-only through this API; their assignments still follow normal controlled delegation.

Permission replacement requires the actor to control every removed and added capability globally, since roles affect all holders. Role assignment/revocation reuses [delegation policy](authorization.md): global `roles.manage` plus control of every effective capability at the requested scope. Client IDs remain opaque UUID scope keys until Issue #13 introduces client records. Global assignments omit `client_id`; client assignments require it. Invalid/duplicate/unauthorized assignments share a denial response. An assignment cannot be revoked through another user's path.

Updates require the revision most recently read. Successful profile, disablement and permission edits increment it once. Stale revisions, duplicate emails and already-disabled accounts yield 409 `conflict`; refresh before submitting again. Assignments have immutable IDs and timestamp revocation instead of revisions. User/role missing reads return 404 `not_found`; unknown user assignment reads return an empty collection. Confirmations are required intent flags; the frontend must provide accessible confirmation dialogs, clear form validation and recovery after errors.

Other safe errors: 400 `invalid_request`, 401 `authentication_required`, 403 `permission_denied`, existing Origin/CSRF/media-type errors, 409 `self_disable`, `last_administrator` or `system_role`, and 500 `internal_error`. Unexpected errors log only fixed codes and correlation IDs; never driver text, SQL, request bodies or profile/password values.

## Recovery administrator policy

The policy was recorded on Issue #10 before implementation. An active user with both effective global `users.manage` and `roles.manage` is a recoverable administrator, regardless of role name or bootstrap marker. Once one exists, account disablement and grant removal must preserve at least one. API self-disablement is also refused.

All administration and existing authorization mutators use the same transaction advisory lock. ALWAYS row triggers guard user disablement and active role/permission removal; a volatile capability query reads fresh state after the lock. This prevents two concurrent removals from each observing the other administrator as a surviving fallback. It also covers existing internal grant mutators. Added role permissions are inserted before obsolete permissions are revoked. The actor's authority is rechecked under the lock before mutation. Trusted migration owners remain an operator boundary; the runtime cannot manage triggers or directly read/write these relations.

Successful disablement revokes every unrevoked session, updates status/revision, and appends the audit event in one transaction. Failure rolls all of them back. Existing disabled-account checks still reject sessions immediately.

## Audit, migration and rollout

Events are `user.created`, `user.updated`, `user.disabled`, `role.created`, `role.permission_changed` and existing `role_assignment.created`/`role_assignment.archived`. Safe before/after markers include existence, revisions and allowlisted account status only. They omit profiles, passwords, permissions lists and session values. Significant writes and audit insertion share `audit.WithTransaction`; audit failure is a failed mutation.

Additive migration `000005_create_administration.sql` adds revisions (existing rows start at 1), narrow security-definer readers/mutators with fixed `pg_catalog` search paths, recovery triggers, and the reviewed audit action/status allowlist. It introduces no runtime table grants and preserves seeded grants and existing audit records. DDL locks users, roles and affected audit/grant relations; use the existing bounded migration lock/statement timeouts and a maintenance window appropriate to table size.

Apply migrations as the separate owner, then apply the reviewed EXECUTE grants in `backend/scripts/grant-runtime.sql`, then start the new API. Existing login/session contracts remain compatible. No new runtime configuration or dependencies are required. Empty down/up is tested; down refuses existing users, custom roles or administration audit/status history, retaining the migration version and data. After populated rollout, use a forward fix or a compatible older API with the additive schema; do not disable recovery guards to force rollback.

## Verification and follow-up

Unit checks cover profile/permission validation, strict decoding and secret-free failures. Disposable database tests cover paginated HTTP contracts, revisions, permissions and browser security, scope isolation, escalation denial, built-in protection, custom recovery roles, concurrent removals, existing mutator protection, session revocation, safe audit markers and rollback of every mutation type when audit insertion fails. Full migration roundtrip and populated refusal remain in the integration suite. CI supplies PostgreSQL 18, container and real browser-authentication checks.

The frontend PR must consume these fields, add permission-guarded user/role destinations, loading/error/empty tables, validated forms, confirmed disablement/permission/assignment actions, revision-conflict recovery and critical-form tests. It must clear passwords after submissions and keep them out of browser persistence and query/mutation caches. Issue #10 remains open until that UI work is verified.
