---
type: decision
status: frontend-review
created: 2026-10-01
tags:
  - authorization
  - audit
  - backend
  - frontend
---

# User and Role Administration

Issue #10 is cross-cutting: backend API first, separately reviewed frontend after owner merge. Do not close the issue with only the backend PR. Prerequisite PR #45 is owner-merged at `5d2d125`; both permanent development branches were synchronized. Main run [36905309471](https://github.com/theroisey/else/actions/runs/36905309471) passed all five gates and tested-image publication.

Backend [PR #46](https://github.com/theroisey/else/pull/46) is owner-merged at `a184bc9`. Local Go format/vet/build/race checks and the full disposable PostgreSQL 17.11 suite passed. Final backend PR run [36912138187](https://github.com/theroisey/else/actions/runs/36912138187) passed all five gates. Main run [36913982322](https://github.com/theroisey/else/actions/runs/36913982322) passed backend, PostgreSQL 18, container and browser checks; the existing frontend logout assertion failed, so publication was skipped. Both development branches were synchronized before frontend work.

## Logout assertion repair

The existing `AuthFlow.test.tsx` logout test intermittently obtains a Sign in heading that routing replaces before `toBeInTheDocument` executes. Failures occurred in run 36911511618 and the backend merge run. The frontend slice now queries/asserts the current heading inside `waitFor` after navigation, retaining transport/private-cache/protected-navigation assertions. [Issue follow-up](https://github.com/theroisey/else/issues/10#issuecomment-5938580497) preserves the evidence. Passing a retry alone was not treated as a fix.

## Frontend behavior and evidence

Users/Roles destinations share exact global view predicates with route guards. Writes use separate manage permissions and scope-aware delegation; built-in definitions are read only. Fixed same-origin transport validates bounded safe envelopes and uses existing cookie/CSRF handling. Successful writes refresh administration reads and identity; denied operations refresh identity so stale controls disappear. Backend permissions remain authoritative.

Initial passwords are uncontrolled fields cleared before a server attempt and never enter query/mutation caches or persistence. Account revision conflicts offer an explicit reload/discard action. Role conflicts require closing/refreshing/reopening before another confirmed replacement. Confirmation dialogs focus Cancel initially; mobile tables retain named keyboard-scrollable regions. Explicit button aria-labels avoid absolutely positioned hidden-label overflow outside a narrow table.

Local checks pass: lint, strict typecheck, production build, 54 component/service tests and production dependency audit (zero findings). All four real API browser flows pass on a fresh disposable PostgreSQL 17.11 database with system Chromium, including create/edit/disable, scoped role assignment/removal, confirmed permission replacement, sole-admin refusal, safe audit events and actual session revocation. CI retains its PostgreSQL 18 container isolation and supplies container/migration proof. Screenshots contain only visibly identified synthetic data. Local harness retries required fresh database/process state, including resetting in-memory authentication throttling; no throttle policy was weakened.

## Recovery and migration policy

The pre-implementation policy is [Issue comment 5937805664](https://github.com/theroisey/else/issues/10#issuecomment-5937805664). Recovery means an active user with both global users.manage and roles.manage, using arbitrary roles. All removals preserve one once present; self-disable is refused. Existing authorization advisory locking is shared with account disablement and ALWAYS grant/status triggers. Volatile reads after acquiring the lock matter for concurrency; a stable snapshot could miss the prior removal. Narrow database functions recheck live permissions under this same lock.

Account disablement, all session revocations, revision increment and safe audit markers are atomic. Role replacement adds permissions before revoking obsolete ones, and requires global control of the union of old/new keys. The initial built-in roles are API read-only. There is no deletion, reactivation or password reset. Keyset pages use immutable UUIDs and limit+1 reads; revisions protect user and role edits. Clients remain opaque exact-match scope UUIDs until #13.

Migration 000005 is additive with runtime EXECUTE only. It extends audit actions only for user.disabled and role.permission_changed and snapshots only for active/disabled status. Populated rollback is refused; empty rollback recreates functions, so reapply grants after up. Password/profile/session values never enter audit or error logs. This frontend slice adds no migration, API change, dependencies or runtime configuration.

- [Administration contract](../../docs/administration.md)
- [[Authorization and Client Scope]]
- [[Identity and Sessions]]
- [[Audit Infrastructure]]
- [[Application Shell and Session Recovery]]
