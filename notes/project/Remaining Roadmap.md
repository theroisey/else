---
type: roadmap
status: active
updated: 2026-10-03
tags:
  - roadmap
  - dependencies
---

# Remaining Roadmap

The user requests completing all issues step by step. GitHub Issues remain the source of scope/acceptance. Continue through dependency-ready slices, with policy recorded before implementation and separate backend/frontend review. Owner merge and deployment remain distinct authorized actions; do not close parents from partial foundations.

Owner merged #90 / PR #91 at `2f797a5`, then Release Center PRs #94/#95. Main `2b0aec7` passed all five gates and tested image publication (run 37145739998); both development branches synchronized and parent #29 closed. Seven original roadmap issues remain open:

| Issue | Next work / dependency |
| --- | --- |
| #24 | Integration lifecycle/sync remains incomplete after encryption, metadata, budgets, disconnect, startup, rotation and live inventory. Broader recovery and provider-specific writers need verified policy. |
| #25 | Meta Ads is already selected. #96 implements daily Insights normalization from verified current official SDK 26.0.2 / Graph v26.0. Verify minimum scopes/account ownership/OAuth/revocation and remaining reporting semantics before live transport/ingestion/UI. |
| #26 | First web analytics provider (proposed GA4): record verified metric/timezone/account isolation/retention policy before implementation. |
| #27 | First commerce provider (proposed Shopify or WooCommerce): record provider, monetary/refund/period/privacy/retention policy before implementation. |
| #30 | Final security review after #24 (#29 complete), with concrete threat model/negative route matrix/dependency evidence and focused defect issues. |
| #31 | Full critical-flow/performance proof after provider work (#29 complete); existing 15 cookie browser tests are partial evidence. |
| #32 | Operating/backup-restore/rollback/provenance rehearsal after #30/#31; explicit target and production approval before rollout. |

Current managed environment has enforced package-manager-only HTTP destinations, no provider credentials/identities and no web research tool. Approved GitHub access supplies authoritative vendor repositories; [[Official Provider Sources]] records verified current revisions. #96 uses the concrete official Meta generated contract for exact bounded normalization. Direct official provider documentation access remains necessary for policy absent from those sources; neither deterministic synthetic tests nor guessed API versions replace it. Do not turn missing evidence into completed provider/security/production acceptance.

All five exact-head CI gates remain required before ready review. Preserve tests, protected data/history and safe diagnostics; record results in PR/Issue metadata without adding source commits merely for CI evidence.
