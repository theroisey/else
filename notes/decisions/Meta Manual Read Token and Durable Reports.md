---
type: decision
status: active
created: 2026-10-04
tags:
  - marketing
  - integration
  - security
---

# Meta Manual Read Token and Durable Reports

Continue existing #25 without new issues or application images. Official Meta permission declarations identify ads_read for Insights; pinned Business SDK 26.0.2 supplies permission/account/daily v26.0 contracts. A separate official Meta transport corroborates header-only Bearer requests. Immutable sources and explicit limits are in `docs/meta-synchronization.md`.

Support operator-provisioned user tokens with current ads_read/account access. No in-app OAuth, refresh, app-secret collection, provider writes or revocation. Every bounded request and complete publication checks fresh local authorization/generation/lease fences. Permission/account checks surround collection; provider links are never followed. Access proof is time-bounded API access, not legal ownership. Unsupported token/app configurations fail safely.

Migration 25 adds typed Meta periods to the existing private shared durable tables, independently validates exact spend/weighted ratios in SQL, and refuses rollback over history. All three providers share two global leases and one fair rotating worker in the single application image. Replace/cancel/audit/encryption-budget/retention boundaries remain unchanged.

The measured Marketing workspace shows exact account-currency decimals, counts, daily observations and weighted CTR/CPC/CPM with unavailable zero denominators and attribution. Ad-account calendars remain independent of Europe/Istanbul display timestamps. Secrets clear before requests/unmount; actor/grant/client/period caches never retain token values. Synthetic checks do not establish real account access or production rollout.

Related: [[Verified Meta Insights Exact Normalization]], [[Durable Integration Encryption Budgets]], [[Single Application Image]], [[Local Integration Disconnect Fence]].
