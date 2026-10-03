---
type: decision
status: active
created: 2026-10-03
tags:
  - marketing
  - integration
  - precision
---

# Verified Meta Insights Exact Normalization

#96 under #25 implements the pure daily account Insights decoder before enabling live transport. Meta's current official SDK 26.0.2 (2026-09-21) pins Graph v26.0; annotated tag resolves to `efd8423a2e595ea8d4c04eb824ce113f2f1d68cd`. Its generated AdAccount/AdsInsights contract verifies endpoint parameters and the seven string-valued row fields. Immutable source links and retrieval evidence live in `docs/meta-insights.md`.

Approved GitHub access can supply authoritative provider source even while direct developer documentation is excluded by the managed network policy. Do not confuse a verified generated contract with verified scopes, OAuth/revocation, account ownership or monetary/attribution semantics. The SDK README points to documentation still unavailable; live credential/transport/ingestion remains gated on those decisions under #24/#25.

Consume only complete bounded pages against already authorized immutable client/connection/account/currency/timezone/period context. Require a terminal page, unique dates/cursors, exact row types and no mixed ownership/currency. Discard raw navigation and account identifiers. Fail atomically with one fixed diagnostic; do not silently sum duplicate observations or return partial totals.

Preserve exact provider decimal spend and integer-string counts. Compute CTR/CPC/CPM from exact source sums, round half up to six fractional digits, and represent zero denominators as null. No minor-unit conversion, conversion attribution, fake zero days or connection/sync success. This is concrete reporting interpretation, not a provider connection or completed parent acceptance.

Related: [[Remaining Roadmap]], [[Integration Connection Metadata and Read Boundaries]], [[Encrypted Integration Credential Persistence]], [[Read-Only Release Center Interface]].
