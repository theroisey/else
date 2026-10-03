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

Owner merged #90 / PR #91, Release Center PRs #94/#95, Meta decoder #96 / PR #97 and security review #98 / PR #99. #99 passed all five exact-head gates in run 37150732254; main is now `b592660` and both development branches synchronized before #100. Main's integration run remains separately observed. Parent #29 is complete. Owner closed #24 on 2026-10-03; provider capabilities and broader operating limitations remain explicit rather than being inferred complete from closure. Six original roadmap issues remain open:

| Issue | Next work / dependency |
| --- | --- |
| #25 | Meta Ads is already selected. #96 implements daily Insights normalization from verified current official SDK 26.0.2 / Graph v26.0. Verify minimum scopes/account ownership/OAuth/revocation and remaining reporting semantics before live transport/ingestion/UI. |
| #26 | First web analytics provider (proposed GA4): record verified metric/timezone/account isolation/retention policy before implementation. |
| #27 | First commerce provider (proposed Shopify or WooCommerce): record provider, monetary/refund/period/privacy/retention policy before implementation. |
| #30 | Owner-merged #98 supplies threat model/compiled matrix. #100/#102 / PR #101 passed all six checks, four real Go scans/npm audit and scoped unused OpenPGP disposition (run 37155777513), ready for owner review. #103 adds nginx CSP/frame defenses and separate built-artifact Chromium evidence; final exact-head runtime checks/risk reconciliation remain. Local database fetch denial is not a clean result. |
| #31 | Full critical-flow/performance proof after provider work (#29 complete); existing 15 cookie browser tests are partial evidence. |
| #32 | Operating/backup-restore/rollback/provenance rehearsal after #30/#31; explicit target and production approval before rollout. |

Current managed environment has enforced package-manager-only HTTP destinations, no provider credentials/identities and no web research tool. Approved GitHub access supplies authoritative vendor repositories; [[Official Provider Sources]] records verified current revisions. Owner-merged #96 uses the concrete official Meta generated contract for exact bounded normalization. Direct official provider documentation access remains necessary for policy absent from those sources; neither deterministic synthetic tests nor guessed API versions replace it. [[Implemented System Threat Review]] records the current controls and limits, including the successful npm audit and unsuccessful Go scan/database-build attempts. Do not turn missing evidence into completed provider/security/production acceptance.

All six exact-head CI gates are required before ready review. [[Persistent Dependency Security Gate]] records actual CI scanning and failure semantics; [[Frontend Browser Security]] records current #103 local enforcement proof and remaining runtime gates. Frontend includes #101's reviewed baseline; identify it as an owner-integration prerequisite. Preserve tests, protected data/history and safe diagnostics; record results in PR/Issue metadata without adding source commits merely for CI evidence.
