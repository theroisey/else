---
type: research
status: partial
updated: 2026-10-04
tags:
  - providers
  - evidence
---

# Official Provider Sources

The managed environment remains restricted to package-manager preset destinations, with no configured provider credentials/identities. Its approved GitHub connector can read the providers' own public repositories. Use immutable vendor sources where they establish a concrete contract; do not use them to assert documentation, account access or policy they do not establish.

- Meta: official `facebook/facebook-python-business-sdk` release 26.0.2, published 2026-09-21, annotated tag `f96d5e3d3a3ffa24e95a25ced642e8ff8dbd5d1f` resolves to `efd8423a2e595ea8d4c04eb824ce113f2f1d68cd`. Graph v26.0 and Insights field/parameter evidence is verified in `docs/meta-insights.md`; #96 supplies exact pure normalization. Direct OAuth/scope/revocation policy remains unverified.
- GA4: user selected it as the first analytics provider. Official `googleapis/googleapis` commit `ed6832a8b8254885e1ddc352bb1dc30b7f26f950`, dated 2026-09-14, supplies reviewed v1beta API/data protos: ordered string/integer rows, offsets/total count, property timezone, compatible/blocked metadata and quality flags. #107 / [[Verified GA4 Integer Report Interpretation]] records bounded pure interpretation. These sources do not establish final concrete metric definitions, property ownership/credential setup or retention policy.
- Commerce: user selected WooCommerce as the first commerce provider. Official `woocommerce/woocommerce` 11.1.2, published 2026-09-22, resolves to `2316335b1bce366178ce865d4e61a4c5e2219352`. Official **archived** REST documentation commit `09431ca9a114289d298fd2a5d5b604ea50f6d197` corroborates current wc/v3 orders/refunds/CRUD/auth source. Embedded negative lifetime refund summaries have no dates; separate positive refund events have dates/parent IDs but no currency. #115 / [[Verified WooCommerce Order and Refund Interpretation]] records exact bounded minimal interpretation and explicit parent currency/independent period semantics. Ownership/SSRF/transport/reconciliation/retention/product/revenue/live access/UI remain open under #27; archive alone is not current policy proof.

Direct `developers.facebook.com`, `developers.google.com` and `shopify.dev` documentation access remains excluded. Enabling those destinations is the external prerequisite for evidence absent from available official sources. Never bypass the proxy, guess API versions or treat synthetic fixtures as live account proof.

Related: [[Remaining Roadmap]], [[Verified Meta Insights Exact Normalization]], [[Verified GA4 Integer Report Interpretation]].
