---
type: decision
status: frontend-review
created: 2026-10-02
tags:
  - planning
  - frontend
  - authorization
  - timezones
---

# Planning Interface and Reference Drafts

Issue #17's frontend follows owner-merged backend PR #52 at `b7b7e95`. Both permanent development branches were synchronized before implementation. Main [run 36976256373](https://github.com/theroisey/else/actions/runs/36976256373) passed all five gates and tested-image publication. The [frontend policy](https://github.com/theroisey/else/issues/17#issuecomment-5947085377) was recorded before source edits. The [interface contract](../../docs/planning-interface.md) documents the delivered behavior. Owner merge closes #17; the agent never merges or deploys.

Planning-only routes require exact-client view independently of clients/tasks. Optional client context never triggers an unauthorized read; parent-plan context is required for every milestone write. Plan and milestone status controls remain explicit, server-confirmed and independent of tasks. Terminal records require reopening; archive preserves child states, references and history. Lists and candidates use 25-record UUID cursor pages and in-memory filters.

Metadata and reference drafts capture separate target revisions. Parent/background refreshes keep drafts mounted; failures disable writes. Conflicts require explicit reload rather than replacing an unsaved draft. Task-link editing withholds competing lifecycle/metadata controls and owns its errors so a rejected save appears once.

References remain IDs, and link history never receives task metadata. Candidate titles exist only in the independently authorized, paged picker. The complete selection persists through paging/search/loading/errors and enforces 50 distinct IDs. Task-view revocation removes the picker and cached titles immediately while keeping draft IDs: retained references remain editable, but new selections must be removed before saving. Removed/relinked references preserve history. No link changes task state or grants access.

Detail/form placeholder data may preserve authorized planning metadata across a same-actor grant refresh within a mounted route scope. Permission guards run before display, keys partition actor/grants/client/parent, and task titles never enter these placeholders. Completed reads also check mounted state, preventing a late old-route mutation from navigating away from the current page. Expiry/logout clears private queries.

Tasks and Planning now share date helpers in `frontend/src/lib/time.ts`; task due indicators remain task-specific. The subprocess DST test imports the shared file directly because native Node cannot resolve extensionless transitive TypeScript imports. Unchanged timestamp strings retain microseconds and later overlap occurrences; changed gap times fail and changed overlap times use the first occurrence.

127 frontend tests, seven real-API browser flows, race-enabled Go units and the complete PostgreSQL integration suite pass locally. Synthetic desktop/tablet/mobile screenshots contain no customer data; auth traces/video remain off. Local PostgreSQL 17.11 is disposable; CI verifies PostgreSQL 18 and containers before readiness. No backend/API/migration/audit-policy changes or new dependencies are introduced.

- [[Planning Lifecycle and Historical Task Links]]
- [[Task Interface and Timestamp Editing]]
- [[Client Interface and Workspace]]
- [[Application Shell and Session Recovery]]
