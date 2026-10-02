---
type: decision
status: merged
created: 2026-10-02
tags:
  - activity
  - frontend
  - authorization
  - privacy
---

# Activity Timeline and Permission Refresh

Issue #22's timeline follows owner-merged API PR #56 at `d507f68`. Both branches were synchronized and main run 37005708004 passed all gates/publication. [Contract 5952256431](https://github.com/theroisey/else/issues/22#issuecomment-5952256431) preceded source edits. The [interface guide](../../docs/activity-interface.md) documents the consumer; owner merge completes #22.

The page reads only the safe event projection. A validated client UUID plus clients.view and activity.view are mandatory. Display exact UTC time and static summary/kind/reference without profile, resource, actor or directory lookups. Plain references preserve archived history and avoid guessing a milestone's missing parent route. Related module links require independent view grants.

Strict event/page/envelope schemas reject expanded metadata and unreviewed labels. Timestamp comparison retains PostgreSQL microseconds and UUID ties; display retains the original time. A future event/DTO expansion requires an explicit reviewed consumer change rather than accidental rendering of new audit data.

Read-only history has no draft-preserving placeholders. Pending/background-failed reads hide cached rows until current authorization and response validation succeed. Shared actor/grant/client partitioning rejects late results. Known grant/actor changes remount the timeline, reset cursors and filter row domains. Server denial refreshes session access; the API remains authoritative when the browser has not yet refreshed a revoked domain grant.

Opaque cursors are passed unchanged and retained only in memory. First-page refresh uses a new query generation, preventing old cached rows being treated as confirmed while revalidation is pending. Earlier pages also revalidate. Each request observes current access without promising cross-request snapshot consistency. There are no invented counts or inferred events.

195 frontend tests (36 activity), nine real-API browser flows, complete Go race/PostgreSQL regressions and dependency audit verify this slice. The browser creates its 28 persisted events through normal business mutations; it neither seeds nor rewrites audit history. Reads preserve audit counts, hide private business text and fetch no unrelated details. Screenshots use labeled isolated synthetic data. Local PostgreSQL 17.11 differs from CI's PostgreSQL 18; final-head CI/container gates are required before readiness.

- [[Client Activity Projection and Read Boundaries]]
- [[Application Shell and Session Recovery]]
- [[Client Interface and Workspace]]
- [[CI and Publication]]

Owner-merged [PR #57](https://github.com/theroisey/else/pull/57) at `1a30014` completed #22. Main run 37011258324 passed all gates/publication. Both branches were synchronized before [[Audit Read Scope and Safe Inspection]] (#28).
