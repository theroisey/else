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

## Existing #27 implementation extension — 2026-10-04

Continue under #27 only; the user prohibited new issues and additional application images. The recorded policy now includes compiled HTTPS Basic GET collection using dedicated Read keys, WordPress nested projections, complete structural pagination, parent-currency include lookups, exact product-line groups, head rechecks and honest collection interval. WordPress 6.8 nested-field implementation is pinned to `5744cd1a13f6da9f09db6d7f14ca66c5bf474ebe`. The earlier pure six-field normalizer remains unchanged; current nested product collection has its separate seven-field contract. No transactional provider snapshot, legal ownership, stock, paid sales, line-level refund allocation or currency conversion is inferred.

Migration 24 extends the existing private analytics jobs/snapshots with mutually exclusive GA4 property dates versus WooCommerce UTC-second start/end/currency. The existing global lifecycle/admission locks cap two running jobs across both providers/replicas. Encrypted setup/audited reservation/atomic replacement, fresh credential/request/publication fences, exact Go/SQL DTO checks and 90-day bounded audited snapshot retention share existing operations. The existing same-image analytics-worker alternates providers. Safe client commerce reads use clients.view plus analytics.view independently, without implying integration grants. See the [complete synchronization contract](../../docs/woocommerce-synchronization.md).

Focused collector/product/credential/transport/store-validation races pass. Seven new WooCommerce and seven GA4 real PostgreSQL tests plus empty migration round-trip/recovery pass (18.219s): exact stored observations, independent grants, isolation, failed-refresh prior data, deterministic snapshot keys, shared replica admission, expired/replaced lease rejection, revocation and audit failures, retained history rollback refusal, malformed worker keys and explicit retry. All ordinary Go race/vet and integration vet pass; full PostgreSQL 18.3 race/recovery/capacity passes in 556.646s. Existing 1,700-request dashboard capacity reaches at most 100 readers and busiest route maximum 1,002.367ms; broader provider/background workload remains #31 work. Atomic monetary fuzzing passes 129,757 executions in 30 seconds. Synthetic inputs never claim real shop access. Final container/CI and measured frontend/browser proof remain required; keep #27 open until actual acceptance is complete.

## Measured workspace implementation

Owner merged backend PR #127 after all six gates, actual single-image worker/private-storage/TLS/recovery checks, and the full regression above. Main `3a61dba` also passed all six and tested-image publication in run 37213065782. Frontend commerce routes consume only those real stored-report contracts, with independent analytics read grants and separately authorized origin/Read-key setup. Shared catalog/status parsing preserves GA4 behavior. Explicit UTC-midnight half-open dates and selected currency partition reads; exact BigInt sums produce only observed daily cohort bars. No payment, recognized revenue, currency conversion, missing-day zeros or netting across different cohorts is inferred. Uncontrolled keys clear before transport and on permission-driven unmount; uncertain writes block replay. See [workspace behavior](../../docs/woocommerce-workspace.md). Final frontend regression/browser/CI results remain separately required.

All 497 frontend tests, lint/typecheck/build, built Go-origin CSP/attack probes and 17 actual disposable PostgreSQL/API browser flows pass at `6f1f85bb`. WooCommerce browser coverage creates audited pending metadata, refuses unconfigured encryption safely, clears both keys, reads empty/synthetic exact reports, switches to an unmeasured currency, preserves independent analytics access after integration-grant removal and removes data after analytics revocation. Desktop/mobile screenshots carry synthetic provenance and have no page overflow. Final single-image/exact-head CI review remains separately required; no provider credential or production activation is claimed.
