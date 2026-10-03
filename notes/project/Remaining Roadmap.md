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

Owner merged inventory, Release Center, Meta decoder and threat-review slices, followed by dependency security PR #101 and browser defenses PR #104. Main is `ffb8810`; run 37158080918 passed all six checks and publication. Both development branches synchronized before #105. Parents #29/#30 are complete within their recorded implemented scope. Owner closed #24 on 2026-10-03; provider capabilities and broader operating limitations remain explicit rather than being inferred complete from closure. Five original roadmap issues remain open:

| Issue | Next work / dependency |
| --- | --- |
| #25 | Meta Ads is already selected. #96 implements daily Insights normalization from verified current official SDK 26.0.2 / Graph v26.0. Verify minimum scopes/account ownership/OAuth/revocation and remaining reporting semantics before live transport/ingestion/UI. |
| #26 | User selected GA4. #107 / [[Verified GA4 Integer Report Interpretation]] prepares complete bounded response interpretation from authoritative Google schemas, rejecting blocked-metric zeros and quality/incomplete data. Final concrete metric definitions/account authorization/transport/retention and measured frontend remain. |
| #27 | User selected WooCommerce. Record verified monetary/refund/period/privacy/retention and shop ownership/transport policy before activation. |
| #31 | User target: 50–100 initial clients, comfortable 500+ growth, 20–50 initial and 100+ concurrent users, ordinary interactions within 1–2 seconds. #105 / [[Implemented API Capacity Baseline]] measures existing compiled API reads; full critical flows, writes, browser and provider/background workload remain. |
| #32 | Vercel or similar managed web hosting with PostgreSQL; required Go API needs a compatible runtime. Review stateless scaling, queries/indexes/caching/pagination/pooling, errors, health, env validation, logging and production runtime. Operating/backup-restore/rollback/provenance rehearsal and owner rollout approval remain separate. |

Current managed environment has enforced package-manager-only HTTP destinations, no provider credentials/identities and no web research tool. Approved GitHub access supplies authoritative vendor repositories; [[Official Provider Sources]] records verified current revisions. Owner-merged #96 uses the concrete official Meta generated contract for exact bounded normalization. Direct official provider documentation access remains necessary for policy absent from those sources; neither deterministic synthetic tests nor guessed API versions replace it. [[Implemented System Threat Review]] records scoped security closure, successful CI scans and residual operating/provider risks. Local blocked scans remain unsuccessful. Do not turn missing evidence into completed provider/production acceptance.

All six exact-head CI gates are required before ready review. [[Persistent Dependency Security Gate]] records actual CI scanning and failure semantics; [[Frontend Browser Security]] records built-artifact enforcement and actual nginx checks, now owner-integrated with all-six/main publication evidence. #105 / PR #106 passes all six exact-head gates in run 37160421159; worst 100-reader route P95 is 1,118 ms on CI's two-CPU runner, with no invalid responses/timeouts, and the complete final database suite passes in 365.618 seconds. It awaits owner integration. #107 is prepared/tested locally without changing #106's reviewed head; separate publication/synchronization/final-head gates remain required. Preserve tests, protected data/history and safe diagnostics; record results in PR/Issue metadata without adding source commits merely for CI evidence.
