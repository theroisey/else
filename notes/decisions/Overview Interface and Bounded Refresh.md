---
type: decision
status: implemented-pending-owner-review
created: 2026-10-02
tags:
  - overview
  - frontend
  - exact-money
  - authorization
---

# Overview Interface and Bounded Refresh

Issue #23 consumes owner-merged backend PR #66 (`378e5cf`). Both branches synchronized after passing main run 37060547663. The [frontend policy](https://github.com/theroisey/else/issues/23#issuecomment-5960954840) preceded code. See [the interface contract](../../docs/overview-interface.md).

The client root now answers operational attention with compact context, due tasks/reminders, a seven-day window, exact finance by currency and recent safe activity. Finance sits beside attention on desktop; mobile stacks and wraps. Full profile/contact/edit/archive workflows remain on the linked profile route, with their existing revision/audit policy. Missing integrations have no invented values or dead actions.

One aggregate request serves initial load, explicit refresh and source-workspace return, without profile/directory/module/summary fanout. React's development effect replay initially duplicated cancelled HTTP reads; yielding a microtask before consuming the query abort signal shares the promise while preserving subsequent cancellation. StrictMode and real request-count tests cover the fix.

Refresh rechecks the session before reading the resulting actor/grant/client partition. Pending, failed and refetching data hides previous values. Locally granted and server-present modules must both agree; activity retains source filtering and suppresses more when masking removes rows. No browser storage or inactive overview cache retains private records.

Strict responses enforce binding, UTC/horizon microseconds, bounded ordered queues, static activity and unchanged exact currency arithmetic. Shared billing/activity schemas avoid duplicate financial or history policy. No write, owner expansion, cost/notes, FX or grand total enters the consumer.

Verification covers 380 frontend tests and thirteen real-API browser flows, including source reconciliation above int64, all due queues, one aggregate request, no read audit writes, grant loss, archived/profile reads and desktop/tablet/mobile keyboard/overflow review. Final-head CI precedes owner review. No agent merge/deployment is authorized.

- [[Client Overview and Authorized Attention]]
- [[Authorization and Client Scope]]
- [[Finance Interface and Payment Recovery]]
- [[Activity Timeline and Permission Refresh]]
- [[Client Interface and Workspace]]
