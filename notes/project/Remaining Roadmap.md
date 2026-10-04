---
type: roadmap
status: active
updated: 2026-10-04
tags:
  - roadmap
  - dependencies
---

# Remaining Roadmap

The user requests completing all issues step by step. GitHub Issues remain the source of scope/acceptance. Continue through dependency-ready slices, with policy recorded before implementation and separate backend/frontend review. Owner merge and deployment remain distinct authorized actions; do not close parents from partial foundations.

Owner merged inventory, Release Center, Meta decoder and threat-review slices, followed by dependency security PR #101, browser defenses PR #104, capacity PR #106, GA4 interpretation PR #108 and runtime budgets PR #110. Main is `7aba203`; both permanent development branches synchronized after those merges. Main run 37187015815 passed all six checks and image publication; capacity main run 37184712171 also passed. Password-work PR #112 and actual logical recovery/compatible rollback PR #114 passed all six exact-head gates and are ready for owner review. Parents #29/#30 are complete within their recorded implemented scope. Owner closed #24 on 2026-10-03; provider capabilities and broader operating limitations remain explicit rather than being inferred complete from closure. Five original roadmap issues remain open:

| Issue | Next work / dependency |
| --- | --- |
| #25 | Meta Ads is already selected. #96 implements daily Insights normalization from verified current official SDK 26.0.2 / Graph v26.0. Verify minimum scopes/account ownership/OAuth/revocation and remaining reporting semantics before live transport/ingestion/UI. |
| #26 | User selected GA4. #107 / [[Verified GA4 Integer Report Interpretation]] prepares complete bounded response interpretation from authoritative Google schemas, rejecting blocked-metric zeros and quality/incomplete data. Final concrete metric definitions/account authorization/transport/retention and measured frontend remain. |
| #27 | User selected WooCommerce. #115 / [[Verified WooCommerce Order and Refund Interpretation]] separates exact order-created/lifetime refund cohorts from independently dated refund events with explicit parent currency. Verify ownership/transport/reconciliation/retention/product/revenue/UI contracts before activation. |
| #31 | User target: 50–100 initial clients, comfortable 500+ growth, 20–50 initial and 100+ concurrent users, ordinary interactions within 1–2 seconds. #105 / [[Implemented API Capacity Baseline]] measures existing compiled API reads; full critical flows, writes, browser and provider/background workload remain. |
| #32 | Vercel or similar managed web hosting with PostgreSQL; required Go API needs a compatible runtime. #109 request/SQL budgets are integrated; #111 bounded Argon and #113 actual logical recovery/compatible source rollback are ready for owner review. Deployed role/key/image/provenance/PITR/RPO/RTO/edge/replica/monitoring/background/ownership/target and traffic approval remain open. |

Current managed environment has enforced package-manager-only HTTP destinations, no provider credentials/identities and no web research tool. Approved GitHub access supplies authoritative vendor repositories; [[Official Provider Sources]] records verified current revisions. Owner-merged #96 uses the concrete official Meta generated contract for exact bounded normalization. Direct official provider documentation access remains necessary for policy absent from those sources; neither deterministic synthetic tests nor guessed API versions replace it. [[Implemented System Threat Review]] records scoped security closure, successful CI scans and residual operating/provider risks. Local blocked scans remain unsuccessful. Do not turn missing evidence into completed provider/production acceptance.

All six exact-head CI gates are required before ready review. [[Persistent Dependency Security Gate]] records actual CI scanning and failure semantics; [[Frontend Browser Security]] records built-artifact enforcement and actual nginx checks, now owner-integrated with all-six/main publication evidence. Owner-integrated #105 / PR #106 passes all six exact-head gates in run 37160421159; worst 100-reader route P95 is 1,118 ms on CI's two-CPU runner, with no invalid responses/timeouts, and the complete final database suite passes in 365.618 seconds. GA4 #107 and runtime #109 are integrated after their six-gate proof. [[Bounded Password Work]] (#111) passed run 37186996511; [[Logical Recovery and Compatible Rollback]] (#113) passed run 37187712580, both ready rather than deployed. WooCommerce #115 retains all activation limits while preparing a focused review. Preserve tests, protected data/history and safe diagnostics; record subsequent CI-only results in PR/Issue metadata instead of adding commits merely for gate evidence.
