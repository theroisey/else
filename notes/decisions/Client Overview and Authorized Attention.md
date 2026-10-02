---
type: decision
status: owner-merged
created: 2026-10-02
tags:
  - overview
  - backend
  - exact-money
  - authorization
---

# Client Overview and Authorized Attention

Issue #23 follows owner-merged pricing PR #65 (`f649c5c`). Both branches synchronized; main [run 37056272195](https://github.com/theroisey/else/actions/runs/37056272195) passed. The [financial/access policy](https://github.com/theroisey/else/issues/23#issuecomment-5960242616) preceded code. See [the overview contract](../../docs/client-overview.md).

One read-only exact-client endpoint combines compact client context, unchanged currency-separated finance, earliest due tasks/reminders and the existing safe activity projection. Fresh clients.view is mandatory; inaccessible modules are omitted with no hidden counts. Every attention queue is five rows plus a sixth-row indicator. Caller clock, limits and filters are rejected. Real stored activity supplies static labels; unimplemented integrations have no invented metrics.

Finance retains numeric sums as strings above int64, the existing UTC overdue rule, cancelled obligation/payment separation and immutable pricing copies. No costs, pricing revenue, payment references, notes, FX or grand total enter the overview.

The runtime makes one aggregate statement. The shared global lifecycle lock precedes fresh checks and pins guarded writes; queued revocation, disable, archival and cancellation are visible. Its timestamp is the statement-start instant, even after waiting. Exact finance still scans indexed client records; bounded output is not constant ledger cost.

Migration 14 adds one partial task deadline index and a PUBLIC-revoked volatile security definer with pg_catalog search path and UTC timezone. Runtime receives the new entrypoint's EXECUTE grant only. Populated down removes only function/index and preserves business/audit history; re-up needs a fresh grant.

Nine PostgreSQL integration tests cover reconciliation, all 16 module combinations, queue/time bounds, safe fields, one measured statement, concurrent write/access changes and populated rollback. Final-head run 37058934276 passed all five gates; the owner merged PR #66 at `378e5cf`. Main run 37060547663 passed and both branches synchronized. The overview UI consumes the contract separately; #23 stays open until that owner acceptance. No agent merge or deployment is authorized.

- [[Authorization and Client Scope]]
- [[Exact Collections and Payment History]]
- [[Versioned Pricing and Immutable Billing Copies]]
- [[Task State and Assignee Scope]]
- [[Reminder Timezones and Historical Ownership]]
- [[Client Activity Projection and Read Boundaries]]
- [[Overview Interface and Bounded Refresh]]
