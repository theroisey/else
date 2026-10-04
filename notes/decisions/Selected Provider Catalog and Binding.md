---
type: decision
status: in-review
created: 2026-10-04
tags:
  - integrations
  - security
  - database
---

# Selected Provider Catalog and Binding

#119 under #26/#27 records policy before migration 22. Exactly meta_ads/ga4/woocommerce; Meta binding/access_token stays byte-compatible, new providers use opaque provider_credential with provider/client/connection AAD. SQL trigger enforces stored provider/purpose even for owner DML. No actual provider credential format/authentication flow is inferred.

GA4 private canonical property IDs and WooCommerce narrow canonical HTTPS store identities are validated at the database constraint. Store syntax is not SSRF/DNS/ownership approval. Future transport must separately protect those boundaries. All seven provider-filtered entrypoints retain signatures, owners, fixed search paths/timezones, PUBLIC revocations, runtime grants, authorization/locks, CAS, audits and reservation consumption. Seven-field metadata remains private-safe.

Empty full migration roundtrip covers 22 versions. Down22 refuses pending/populated selected-provider facts and unresolved connection/credential audits; Meta-only down/up retains data/grants and exact function policy. Actual logical recovery adds mixed-provider ciphertext/current API evidence with explicit denial by the pinned integrated Meta-only previous artifact. Neither deletion/down nor old-artifact success is invented for rollback.

The [catalog guide](../../docs/selected-provider-catalog.md) records limits. Local focused lifecycle/identity/migration/recovery and audit/function-policy checks pass. All Go race/vet/static builds pass; the full disposable database regression, including unresolved-history refusal, is running before final local acceptance. Final full local/CI evidence belongs in #119/its PR. No setup, egress, sync, metric, seed account, merge, deployment or parent completion.

- [[Selected Provider Workspace Compatibility]]
- [[Logical Recovery and Compatible Rollback]]
- [[Remaining Roadmap]]
