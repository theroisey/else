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

## Billing permission consumer preparation

Issue #19's [recorded permission contract](https://github.com/theroisey/else/issues/19#issuecomment-5955336416) prepares client-defined billing.create/update/delete in the frontend known-key map before the backend adds definitions. Administration catalog and role parsers otherwise reject expanded responses. Identity parsing already retains structurally valid future keys; capability checks still reject unknown identifiers. The current runtime catalog/seeds remain 30 keys, while the prepared consumer knows 33. No runtime grant, money calculation, API or finance screen is added.

Each new key requires exact-client scope or a global assignment with an explicit valid client. Legacy billing.manage, billing.view and other write keys never imply a new capability; write keys never imply view. Delegation still needs global roles.manage and every applicable grant, while global role-definition changes require global control. Future backend writes require view plus their specific write permission; cancellation uses confirmed billing.delete. Only Initial Administrator will receive default links, leaving Finance and custom roles to explicit grants.

Seven contract cases and one component flow verify identity preservation, expanded/legacy role/catalog responses, scope/delegation negatives, unknown-key rejection and the confirmed role-edit command. Monetary/refund/reversal/rounding/overdue policy and collections/payment implementation remain pending in #19. Owner-merged audit compatibility #60 at c030361 passed all main gates/publication in run 37024225863; both permanent branches were synchronized before this slice. Owner review remains the merge boundary.

Owner merged permission prerequisite #61 at 2693164; main run 37032475739 passed all gates/publication. Issue #19 now adds the three backend definitions/default administrator links, bringing the runtime catalog to33 as recorded before implementation. Its [[Exact Collections and Payment History]] decision and [API guide](../../docs/billing.md) define the monetary, history and authorization contract. Finance/custom roles remain unchanged.
