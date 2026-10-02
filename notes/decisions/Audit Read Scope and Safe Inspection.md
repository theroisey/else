---
type: decision
status: backend-review
created: 2026-10-02
tags:
  - audit
  - authorization
  - database
  - privacy
---

# Audit Read Scope and Safe Inspection

Issue #28 follows owner-merged activity interface #57 at `1a30014`. Both permanent branches were synchronized; main run 37011258324 passed all gates/publication. [Policy contract 5953240480](https://github.com/theroisey/else/issues/28#issuecomment-5953240480) preceded implementation. The [read API guide](../../docs/audit-reader.md) records the backend contract. Its frontend table/detail/diff consumer follows owner API review/merge; #28 remains open.

Keep the established audit.view key global-only. Global audit permission exposes global security events; client-linked events additionally require a real client and current clients.view. Client-scoped role assignments cannot confer the global key. Archived clients remain inspectable. Inside visible clients the audit privilege deliberately permits cross-domain safe security markers, without requiring business-domain views; activity remains a separate narrower projection.

Two guarded SECURITY DEFINER functions repeat current grants/active-user checks. No raw audit SELECT or profile/actor join is introduced. Global denial uses 403; missing/inaccessible client/events share 404 after root checks. Filters are exact/bounded and keysets bind normalized route/filter semantics. Cursor boundaries require no event lookup, retaining safe continuation after client access revocation. Each page has statement consistency, not a cross-request snapshot. A service deadline bounds sparse scans as well as page size.

Summary references contain actor/event/client/resource/schema/time/request identifiers only. Detail adds explicit safe status/existence/revision/reminder markers and source enum. Read snapshot keys are independent of storage expansion. Revision markers serialize as decimal strings so JavaScript preserves all int64 values; the consumer must keep these strings when showing differences. UTC timestamps preserve microseconds. Names, profile text and credentials never enter either projection. Historical IDs remain references after disabling/deleting profiles.

Reads append no audit event: existing safe HTTP request/correlation/status logs avoid recursion and leave append-only history unchanged. Migration 11 adds readers, a private projector and one global time index, changing no catalog/seed/payload/history. Down removes only reader objects/index; recreation requires reviewed EXECUTE grants. The transactional index build requires an operational maintenance/lock-budget decision, not an agent deployment.

Five unit, nine integration and one HTTP adapter checks verify the read policy alongside full Go/PostgreSQL regressions, 195 frontend tests and nine browser flows. Local PostgreSQL 17.11 differs from required CI PostgreSQL 18. Existing activity migration tests now target version 9 explicitly when exercising migration 10, preserving their scope as newer reader migrations are added. Complete empty roundtrips include eleven migrations.

- [[Audit Infrastructure]]
- [[Authorization and Client Scope]]
- [[Client Activity Projection and Read Boundaries]]
- [[Activity Timeline and Permission Refresh]]
- [[CI and Publication]]
