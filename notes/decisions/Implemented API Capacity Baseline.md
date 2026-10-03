---
type: performance
status: in-review
created: 2026-10-04
tags:
  - performance
  - database
  - readiness
---

# Implemented API Capacity Baseline

Issue #105 under #31 turns the user's concrete scale/latency assumptions into actual compiled Go API/disposable PostgreSQL read measurements. User selected GA4/WooCommerce and proposed Vercel-or-similar managed hosting: retain Go API and assess its compatible runtime/same-origin/secret/database topology under #32. No deployment or provider activation is authorized by readiness design.

Dataset: 500 measured clients (+two base), 50k tasks, 20k reminders, 10k unpaid collections, 5k one-version/one-line pricing sheets; 100 independent real read-only sessions, unchanged ten-connection pool. Cold/warm stages then 20/50/100 workers ×10 requests measure each route's P95 against a fixed two-second API screening ceiling. Default 25-row and maximum 100-row directory pages matter: initial five-row smoke results were insufficient as ordinary pagination evidence. Validate actual data/balances/cardinality/cursors/client ownership, not merely fast status codes. No retry or excluded timeout.

Use a private three-minute large-fixture lifetime; existing fixtures keep thirty seconds. Shared compiled startup preserves the security matrix and joins before log inspection. Counts/revisions/history/audit/sessions stay unchanged and no tokens/passwords/bodies enter reports. Verbose integration output retains safe metrics on successful CI. Real normal/max-page/full-suite/final-head evidence belongs in issue/PR metadata before ready.

Short API-only burst is not browser/edge/soak/mixed-write/live-provider/multi-instance readiness or a production SLA. Keep final #31/#32 acceptance open and measure remaining concrete workload aspects. No speculative index/cache changes.

- [[Remaining Roadmap]]
- [[Implemented System Threat Review]]
- [[Frontend Browser Security]]
- [Capacity guide](../../docs/capacity-readiness.md)
