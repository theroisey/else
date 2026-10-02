---
type: decision
status: backend-review
created: 2026-10-02
tags:
  - planning
  - authorization
  - audit
  - migrations
---

# Planning Lifecycle and Historical Task Links

Issue #17 follows owner-merged task interface PR #51 at `bf435f0`. Both permanent development branches were synchronized. Main [run 36964008720](https://github.com/theroisey/else/actions/runs/36964008720) passed all five gates and tested-image publication. No deployment was performed.

The [pre-implementation policy](https://github.com/theroisey/else/issues/17#issuecomment-5945928902) settles immutable client/plan ownership, historical server authorship, independent revisions, explicit state machines, UTC dates and history-preserving rollback. The [planning contract](../../docs/planning.md) is the consumer API reference. Backend work references #17; the frontend follows owner merge and closes it separately.

Planning requires view plus the operation's create/update/archive permission for the exact client; no legacy aggregate exists. Initial Administrator alone gets seed links. The minimal frontend known-key map adds all four keys because unknown identity grants would otherwise break existing sessions and administration. There is no planning UI in the backend PR.

Plan completion is manual and independent of milestones/tasks. Terminal metadata/link edits require reopen. Every child write requires an active nonterminal parent plan. Archive retains children and links without changing their revisions or status. Milestone dates remain within supplied plan boundaries; a parent date edit checks nonarchived children under the shared writer lock. Archived dates are historical.

Only milestones link tasks, with a complete replacement set capped at 50. Composite foreign keys enforce matching client ownership. Removed links are dated, retained rows; relinking inserts a new row. New links require task view and an active same-client task. Unchanged references survive archival/revocation; removal needs planning update alone. Planning reads expose IDs/times only; candidate discovery separately requires task view and returns bounded ID/title/status. Linking never grants task access or changes task status.

Writes acquire authorization advisory lock `871092650209` before fresh state checks, then lock parent/target and compare the target revision. A correlated audit transaction records only existence, revision and resource-bound `planning_status`. Audit failure rolls back link removals/inserts and all record changes. Migration 000008 refuses rollback with any planning/audit/custom-or-revoked-permission history; drain writers and reapply reviewed runtime grants after owner migration.

Real PostgreSQL tests cover 32 state pairs, date windows, scoped permissions, ownership, link limits/privacy/history, audit rollback, private helpers/storage, concurrent revisions and eight lock-wait races. Previous migration tests first roll back the new unused planning migration before checking older guards, retaining their original guarantees. Local regression uses PostgreSQL 17.11; CI verifies PostgreSQL 18 and container behavior.

- [[Task State and Assignee Scope]]
- [[Task Interface and Timestamp Editing]]
- [[Authorization and Client Scope]]
- [[Client Records and Scope History]]
- [[Audit Infrastructure]]
