---
type: decision
status: in-review
created: 2026-10-04
tags:
  - ecommerce
  - exact-money
  - provider
---

# Verified WooCommerce Order and Refund Interpretation

The user chose WooCommerce. #115 under #27 uses current official 11.1.2 commit `2316335b1bce366178ce865d4e61a4c5e2219352`, cross-checked against official archived documentation commit `09431ca9a114289d298fd2a5d5b604ea50f6d197`. Archive status is explicit; current source corroborates wc/v3, decimal/GMT/parent/refund contracts and HTTPS Basic read permission. Neither source proves a supplied shop's ownership or credentials.

Embedded order refunds have negative totals and no date, so order-created grand/lifetime-refund/remainder totals cannot be mislabeled refund-period totals or recognized/cash revenue. Separate wc/v3/refunds events have positive amounts and dates but no currency: require explicit trusted exact parent-currency binding, including outside-period parents. Preserve standard statuses without payment inference. Never combine mismatched cohorts or currency sums.

Pure atomic interpretation bounds five 64KiB pages/500 rows, strict total/page counts and ordered integer IDs, exact minimal projections, UTC half-open <=31-day periods, fixed six-decimal source precision and reviewed zero-/two-/three-place currency conversion without rounding. At most 50 embedded refunds per order. Shared strict provider-object boundary preserves Meta/GA4 tests. No credentials, network, route, persistence, setup success or frontend. Header agreement is structural evidence, not a stable provider snapshot; filter boundaries and minimal projection remain later producer obligations.

Final local provider and all Go race tests, ordinary/integration vet and readonly static builds pass. Final 30-second three-worker atomicity/binding/arithmetic fuzzing passes with 19,708 executions after identity/nested-bound additions (initial source also passed 215,993 executions). All six final-head CI gates and owner review remain required. The [guide](../../docs/woocommerce-reports.md) records authoritative source links, policy and remaining #27 activation/retention/product/revenue/lifecycle/UI work.

- [[Official Provider Sources]]
- [[Remaining Roadmap]]
