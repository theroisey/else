---
type: decision
status: in-review
created: 2026-10-04
tags:
  - analytics
  - integrations
  - security
---

# GA4 Read-Only Aggregate Collection

Continue directly under existing #26; the user prohibits new issues and requires one application Docker image. GA4 and WooCommerce were explicitly selected. [[Verified GA4 Integer Report Interpretation]] remains the narrow integer contract; `NormalizeMetricReport` additionally supports dimensionless totals and exact bounded decimal attribution without broadening the legacy function.

First GA4 credential is a provisioned Google service-account PKCS#8 RSA key (2048–4096 bits, conventional exponent, bounded ASN.1 preflight), fixed OAuth JWT assertion exchange to oauth2.googleapis.com/token with sole analytics.readonly scope. No credential-provided endpoint, impersonation, direct self-signed access, refresh loop or public secret DTO. [[Official Provider Sources]] records immutable vendor contracts.

The [adapter guide](../../docs/ga4-adapter.md) documents fixed Admin/Data origins, exact property identity/deletion/timezone, five compiled aggregate templates, per-request fresh compatibility/unblocked definitions, separate period users, property-local 31-day dates, exact count/attribution strings, stable complete 1,000-row bounds and atomic quality/privacy/cancellation errors. Provider descriptions are text, never instructions or markup. Landings omit queries and identifiers; relative paths can still contain sensitive content, so property collection configuration must exclude personal data.

[[Bounded Provider HTTPS]] now permits only two compiled body budgets: ordinary 64 KiB and fixed projected GA4 compatibility catalog 256 KiB. All other TLS/DNS/request/time/admission guards remain unchanged. There is no arbitrary public byte-limit input. Share the same two-slot process gate for token, Admin and Data calls.

The surrounding [synchronization service](../../docs/ga4-synchronization.md) now implements pending metadata, locally validated encrypted setup, PostgreSQL jobs, two global running leases/three crash attempts, per-request fresh fences, lifecycle-held bounded decryption, atomic complete publication, deterministic snapshots, independent analytics.view reads and audited 90-day aggregate retention. API requests never call providers; the worker closes DB transactions before network work. Its binary is packaged in the same final image. Explicit provider periods are not silently shifted or automatically scheduled. Provider failure requires explicit retry. Frontend and full latest-artifact checks remain in progress. Synthetic tests do not establish live account ownership; remote CI is separate. Do not close #26 from library/focused checks.

Related: [[Selected Provider Catalog and Binding]], [[Encrypted Integration Credential Persistence]], [[Remaining Roadmap]].
