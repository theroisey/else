---
type: decision
status: implemented-pending-owner-review
created: 2026-10-02
tags:
  - pricing
  - frontend
  - exact-money
  - authorization
  - recovery
---

# Pricing Interface and Collection Copy Recovery

Issue #21 consumes owner-merged backend PR #64 (`2405d39`). Both branches synchronized after passing main run 37049174588. The [UI policy](https://github.com/theroisey/else/issues/21#issuecomment-5959050907) preceded implementation; see [the interface contract](../../docs/pricing-interface.md).

Exact-client grants govern pricing independently of profile access. Manager costs stay absent from view-only responses and all snapshots. Actor/grant/client partitions isolate private caches and drafts; context changes suppress late results. Billing.view alone retains copied terms.

Plain-text quantity/price/percentage conversion uses BigInt. Server previews are authoritative and invalidated by any draft change. Append preserves history and supplies latest revision. Unknown/stale writes freeze for history review; no automatic retry or revision substitution.

Collection copies retain original UUID, selected version, sheet revision and payload above page routes. Back preserves identical replay. Unknown retry conflicts never prove noncommit or permit replacement. No browser storage persists private commands; reload/auth-tree/identity/grant loss requires financial reconciliation. The controller resets independently so unrelated planning/reminder drafts retain existing behavior.

Finance locks copied amounts before payment. Snapshot failures lock conservatively; only 404 plus fresh accessible collection detail permits manual-origin editing. Later prices cannot alter copied amounts/lines. Metadata/payment/cancellation retain their contract.

Verification includes 344 frontend tests and twelve browser flows with synthetic screenshots. Pricing commits before dropping the response, survives Back, sends byte-identical retry, proves one collection/audit event, appends and checks retained billing lines, then revokes manage/view independently. Final-head CI and owner review remain required; no merge/deployment is authorized.

- [[Versioned Pricing and Immutable Billing Copies]]
- [[Finance Interface and Payment Recovery]]
- [[Authorization and Client Scope]]
- [[Application Shell and Session Recovery]]
