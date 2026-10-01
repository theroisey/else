---
type: decision
status: merged
created: 2026-10-01
tags:
  - authorization
  - database
  - security
---

# Authorization and Client Scope

Issue #9 uses permission identifiers rather than role-name checks. Permission definitions have global or client scope. Global assignments can satisfy client permissions for every client; client assignments satisfy only client-scoped permissions for their exact client and never confer global permissions. Unknown permissions, incomplete scope, inactive users and lookup failures deny.

Assignment writers require global `roles.manage` and effective control of every permission being delegated. Narrow database functions combine this decision and the write under a transaction lock, while the application audit transaction makes the assignment and immutable event atomic. Runtime receives no direct authorization-table access.

The bootstrap marker is converted into a normal Initial Administrator role assignment by migration or bootstrap and has no authorization meaning. Initial Administrator, Finance and Viewer are seeded data, not code branches. Current identity exposes flattened, explicitly scoped grants for clients, while backend boundaries remain authoritative.

Client UUIDs are opaque scope keys until Issue #13 adds client records and referential constraints. Issue #10 owns user/role administration APIs; this slice establishes storage, policy evaluation and audited internal assignment primitives only.

- [[Identity and Sessions]]
- [[Audit Infrastructure]]
- [[PostgreSQL Foundation]]
- [Authorization contract](../../docs/authorization.md)
- [Issue #9](https://github.com/theroisey/else/issues/9)
- [Merged PR #43](https://github.com/theroisey/else/pull/43)
- [Main verification and publication](https://github.com/theroisey/else/actions/runs/36870754791)
