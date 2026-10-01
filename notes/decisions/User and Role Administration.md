---
type: decision
status: backend-review
created: 2026-10-01
tags:
  - authorization
  - audit
  - backend
---

# User and Role Administration

Issue #10 is cross-cutting: backend API first, separately reviewed frontend after owner merge. Do not close the issue with only the backend PR. Prerequisite PR #45 is owner-merged at `5d2d125`; both permanent development branches were synchronized. Main run [36905309471](https://github.com/theroisey/else/actions/runs/36905309471) passed all five gates and tested-image publication.

The pre-implementation policy is [Issue comment 5937805664](https://github.com/theroisey/else/issues/10#issuecomment-5937805664). Recovery means an active user with both global users.manage and roles.manage, using arbitrary roles. All removals preserve one once present; self-disable is refused. Existing authorization advisory locking is shared with account disablement and ALWAYS grant/status triggers. Volatile reads after acquiring the lock matter for concurrency; a stable snapshot could miss the prior removal. Narrow database functions recheck live permissions under this same lock.

Account disablement, all session revocations, revision increment and safe audit markers are atomic. Role replacement adds permissions before revoking obsolete ones, and requires global control of the union of old/new keys. The initial built-in roles are API read-only. There is no deletion, reactivation or password reset. Keyset pages use immutable UUIDs and limit+1 reads; revisions protect user and role edits. Clients remain opaque exact-match scope UUIDs until #13.

Migration 000005 is additive with runtime EXECUTE only. It extends audit actions only for user.disabled and role.permission_changed and snapshots only for active/disabled status. Populated rollback is refused; empty rollback recreates functions, so reapply grants after up. Password/profile/session values never enter audit or error logs. Frontend must avoid retaining passwords in mutation caches.

- [Administration contract](../../docs/administration.md)
- [[Authorization and Client Scope]]
- [[Identity and Sessions]]
- [[Audit Infrastructure]]
- [[Application Shell and Session Recovery]]
