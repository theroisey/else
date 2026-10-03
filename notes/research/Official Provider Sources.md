---
type: research
status: partial
updated: 2026-10-03
tags:
  - providers
  - evidence
---

# Official Provider Sources

The managed environment remains restricted to package-manager preset destinations, with no configured provider credentials/identities. Its approved GitHub connector can read the providers' own public repositories. Use immutable vendor sources where they establish a concrete contract; do not use them to assert documentation, account access or policy they do not establish.

- Meta: official `facebook/facebook-python-business-sdk` release 26.0.2, published 2026-09-21, annotated tag `f96d5e3d3a3ffa24e95a25ced642e8ff8dbd5d1f` resolves to `efd8423a2e595ea8d4c04eb824ce113f2f1d68cd`. Graph v26.0 and Insights field/parameter evidence is verified in `docs/meta-insights.md`; #96 supplies exact pure normalization. Direct OAuth/scope/revocation policy remains unverified.
- GA4: official `googleapis/googleapis` latest commit touching `google/analytics/data/v1beta/analytics_data_api.proto` is `ed6832a8b8254885e1ddc352bb1dc30b7f26f950`, dated 2026-09-14. This lookup establishes the source location/revision, not the full #26 metric, account, scope, timezone or retention policy. Read the immutable proto and corresponding official provider implementation/docs before choosing that contract.
- Commerce: official `woocommerce/woocommerce` latest release lookup returned 11.1.2, published 2026-09-22. WooCommerce is an existing proposed option on #27; no provider selection or revenue/refund/currency/ownership policy has been decided from a release tag alone. Inspect the official versioned REST implementation/tests before implementation.

Direct `developers.facebook.com`, `developers.google.com` and `shopify.dev` documentation access remains excluded. Enabling those destinations is the external prerequisite for evidence absent from available official sources. Never bypass the proxy, guess API versions or treat synthetic fixtures as live account proof.

Related: [[Remaining Roadmap]], [[Verified Meta Insights Exact Normalization]].
