---
type: decision
status: owner-merged
created: 2026-10-01
tags:
  - tasks
  - authorization
  - database
  - audit
---

# Task State and Assignee Scope

Issue #15 follows owner-merged client UI PR #49 at `97aae34`. Both permanent development branches were synchronized. Main [run 36933129639](https://github.com/theroisey/else/actions/runs/36933129639) passed all five gates and tested-image publication; no deployment was performed. The pre-implementation policy is [comment 5941777252](https://github.com/theroisey/else/issues/15#issuecomment-5941777252).

Tasks are independent exact-client capabilities. New create/update/delete keys coexist with legacy tasks.manage as a write aggregate, without view. Migration catalog setup explicitly seeds only Initial Administrator; it preserves custom roles/history and follows the original seed convention. Delegation still requires explicit ownership of each key, even where manage can perform a task write. The tiny frontend catalog change preserves identity/administration compatibility; task UI stays #16.

New/changed assignees must be active and effectively view tasks for the exact client. Unchanged disabled/revoked assignees remain historical references; clear/change is explicit. A bounded picker returns only eligible IDs/display names to callers with view and create/update/manage, avoiding a new general directory permission or email exposure. A picker result is advisory: every write rechecks under the authorization advisory lock, after waiting. Creator/assignee never imply access.

Seven states use the explicit matrix in the API guide. Initial states are backlog/todo. Completion/cancellation times are server-owned and cleared on reopening. Terminal metadata is locked until reopen. Separate status writes make transitions reviewable and auditable; dates never auto-transition tasks. UUID keysets avoid mutable state/title cursors. Full metadata/tag replacement and all state/archive operations increment a single optimistic revision.

Task deletion means confirmed soft archive under tasks.delete/manage. History, state, timestamps and children remain. Archived parents/tasks accept no writes; authorized historical reads continue. No restore or physical deletion is exposed. Comments/attachments/planning are separately scoped.

Every write uses the existing correlated audit transaction. Task snapshots add only allowlisted task_status to universal existence/revision; completion/cancellation actions and the state marker are bound to task resources in Go and SQL. No task text, tags, assignees or personal contact data enters audit or request logs. Runtime cannot access task tables or unchecked private helpers.

Migration 000007 is additive. Down refuses task rows, task audit history and new/revoked granular permission assignment history; it removes only untouched seed links and restores the administration-era audit contract. Empty up/down/up passes, and existing populated clients remain intact during unused-task rollback. Older rollback tests explicitly step past empty migration 7 before asserting their original guards. Drain writers for the DDL/audit constraint locks; do not erase history to make rollback succeed.

Verification covers all 49 state pairs, timestamps/reopening/archive, exact client isolation, granular and legacy capabilities, candidate privacy, disabled/revoked references, atomic audit failure, bounded pages/filters, runtime denial and migrations. Four lock-wait races prove fresh actor/assignee/parent checks; concurrent revisions commit exactly one event. Local full PostgreSQL 17.11 race suite, Go checks/build, 72 frontend tests and five existing browser flows pass. Owner merged backend PR #50 at `9b42a90` after all five final-head CI gates passed, including pinned PostgreSQL 18 and containers. Main run 36959187201 passed the same gates and tested-image publication. Both development branches were synchronized before #16. No deployment was performed. See [[Task Interface and Timestamp Editing]] for the frontend slice.

- [API contract and rollout](../../docs/tasks.md)
- [[Client Records and Scope History]]
- [[Client Interface and Workspace]]
- [[Authorization and Client Scope]]
- [[Audit Infrastructure]]
