---
type: decision
status: implemented-pending-owner-review
created: 2026-10-02
tags:
  - pricing
  - backend
  - database
  - exact-money
  - authorization
---

# Versioned Pricing and Immutable Billing Copies

Issue #21 follows owner-merged #19/#20. PR #63 merged at `347fee0`; both development branches synchronized and main run 37043928202 passed. The [financial/auth/history policy](https://github.com/theroisey/else/issues/21#issuecomment-5958282276) was recorded before code. See the [pricing API contract](../../docs/pricing.md). Backend and frontend remain separate owner reviews; Issue #21 stays open until the authorized forms/history UI is reviewed.

Canonical int64 strings represent minor units and fixed six-decimal quantity micros; bps strings permit 0–10000. Compute positive half-up base, discount, net, tax and total per line, then sum. Go big.Int and SQL numeric prevent intermediate overflow; reject any resulting int64 overflow. Explicit sheet currency comes from the reviewed six-code catalog. Frequency is descriptive. No float input, auto invoices, FX, proration or refunds.

Sheets have immutable currency and exact latest revision. Full append-only versions/lines retain original title/note/dates/author/calculated totals. Initial starts may be historical; subsequent starts must be >= today and >= previous start. Same-day successors supersede earlier versions for that day. Successor start derives a cap on the prior window without rewriting history. Exclusive original ends permit gaps; select highest eligible revision before checking its original end. Independent sheets can overlap. No future-version removal/reordering.

Pricing reads need exact-client pricing.view; preview/create/append also need pricing.manage. Costs appear only with current manage, are unknown if incomplete, and never enter billing copies/audit/activity/logs/URLs. Existing permission catalog/seeds and audit-reader safe markers stay unchanged. Writers use the shared authorization/lifecycle lock and fresh checks after queuing.

An explicit command creates one collection from a chosen effective version's positive computed total, under pricing.view + billing.view + billing.create. Billing date cannot be future. Original command UUID, actor, sheet/version/revision and normalized date/due/note identify replay. Identical committed retry returns original collection/current revision, even after later prices, archival or cancellation, under current required grants. Mismatches return conflict; unknown commit must preserve and reconcile original identity. No automatic replacement/retry with a new revision.

Snapshot endpoint uses billing.view alone. It retains copied terms after pricing access loss and omits internal costs/pricing notes/collection notes. Existing collection DTO is unchanged for the merged finance UI. Copied amount/currency freeze immediately, while metadata, payments and cancellation use existing rules. One atomic billing.created event records copy; pricing events contain only exists/revision.

Migration13 is relational and append-only with scoped composite references, immediate amount guards and deferred sum/copy/sequence checks. Transaction IDs bind lines to creation so a later zero-value insertion cannot alter history unnoticed. Runtime has six reviewed EXECUTE grants, no table/private projector/calculator access. Empty down preserves finance/audit; populated pricing or pricing audit refuses rollback. No deployment/history rewrite.

Focused real-database tests cover precision/ties/scales/bounds, chronology/gaps/future, cost privacy, grant matrices, scoped binding, copy/payment/replay compatibility, audit failures, schema boundaries and concurrent/queued revocation/disable/archive. Full backend race and existing frontend/browser/container CI are required before readiness.

- [[Exact Collections and Payment History]]
- [[Finance Interface and Payment Recovery]]
- [[Authorization and Client Scope]]
- [[Audit Read Scope and Safe Inspection]]
