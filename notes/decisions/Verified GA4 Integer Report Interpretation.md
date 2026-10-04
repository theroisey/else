---
type: decision
status: in-review
created: 2026-10-04
tags:
  - analytics
  - providers
  - security
---

# Verified GA4 Integer Report Interpretation

User selected GA4 for #26 and WooCommerce for #27. #107 interprets only complete already-collected GA4 v1beta integer tables, using Google's immutable official API/data protos at `ed6832a8b8254885e1ddc352bb1dc30b7f26f950`. The [contract guide](../../docs/ga4-integer-reports.md) links reviewed source and distinguishes field evidence from unverified metric/ownership/credential policy.

Caller must freshly authorize/fence property/client/connection and verify compatible, unblocked, noncustom aggregate dimension/integer metric metadata. RunReport echoes neither property ID nor requested date range; decoder expectation integrity is not ownership, privacy or freshness proof. No arbitrary dimension text establishes a safe collection policy. No live credentials/transport/persistence/audit/frontend success is enabled.

Support one inclusive property-local period up to 31 days, 1–3 dimensions/1–6 integer metrics, 1–5 ordered pages of at most 64KiB, fixed 1–250 request limit and at most 1,000 rows. Require exact header/type/order/width, stable total, recorded contiguous offsets, unique tuples and full completion. Use strict duplicate/unknown/case/null/type rejection. Preserve exact canonical nonnegative integers up to 18 digits; no float, summed users, manufactured zero rows or date/acquisition interpretations. Empty observations and measured zero differ.

Blocked metadata can produce successful zeros: reject it and any response restriction, thresholding, sampling, data loss, truncation or empty reason. Late failures discard all rows with one fixed safe error. Omitted protobuf zero/empty defaults and explicit unrestricted false/empty flags are allowed; unsupported representations and nonempty aggregates/quota remain unavailable. Synthetic bounds/adversarial/fuzz evidence does not substitute for property access or final #26 acceptance.

Next: verified concrete metric definitions, authorization/transport/retention/privacy/fencing design, bounded background ingestion and separate measured frontend. Required six exact-head gates and owner integration remain distinct. #31/#32 must assess provider background load before activation.

- [[Official Provider Sources]]
- [[Remaining Roadmap]]
- [[Implemented API Capacity Baseline]]
- [[Verified Meta Insights Exact Normalization]]
