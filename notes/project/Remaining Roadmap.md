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

Owner merged #90 / PR #91 at `2f797a5`. Eight original roadmap issues remain open:

| Issue | Next work / dependency |
| --- | --- |
| #29 | Dependency-ready Release Center. #92 implements backend stamp/read contract; frontend follows with real runtime metadata and honest unavailable source states. |
| #24 | Integration lifecycle/sync remains incomplete after encryption, metadata, budgets, disconnect, startup, rotation and live inventory. Broader recovery and provider-specific writers need verified policy. |
| #25 | First marketing provider: verify current official API/version/endpoints/minimal scopes/account ownership/reporting and OAuth/revocation fixtures before provider code. |
| #26 | First web analytics provider (proposed GA4): record verified metric/timezone/account isolation/retention policy before implementation. |
| #27 | First commerce provider (proposed Shopify or WooCommerce): record provider, monetary/refund/period/privacy/retention policy before implementation. |
| #30 | Security review after #24/#29, with concrete threat model/negative route matrix/dependency evidence and focused defect issues. |
| #31 | Full critical-flow/performance proof after provider work and #29; existing cookie browser tests are partial evidence. |
| #32 | Operating/backup-restore/rollback/provenance rehearsal after #30/#31; explicit target and production approval before rollout. |

Current managed environment has enforced package-manager-only HTTP destinations, no provider credentials/identities and no web research tool. Official provider documentation access is an actual prerequisite; neither deterministic synthetic tests nor guessed API versions replace it. Progress independent #29 while resolving access. Do not turn missing evidence into completed provider/security/production acceptance.

All five exact-head CI gates remain required before ready review. Preserve tests, protected data/history and safe diagnostics; record results in PR/Issue metadata without adding source commits merely for CI evidence.
