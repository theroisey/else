---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - backend
  - security
  - operations
---

# Live Integration Key Retention Inventory

Issue #90 records global authorization, bounded source-relative disclosure and read-only/exhausted-material policy before code. It follows owner-merged #88 / PR #89 at `1572cc3`; final-head run 37137926217 and main run 37139320933 passed all five verification gates. Both development branches synchronized before implementation. Parent #24 remains open.

The existing trusted command accepts only `--inventory --actor UUID` (either flag order) for observation. Actor attribution does not authenticate an operator: protected runtime database/key access remains privileged writer authority. Fresh active-actor global clients.view AND integrations.manage grants are mandatory, including empty observations. Client-only grants cannot disclose global counts. Shared lifecycle locking precedes grant and identity reads.

Migration 21 provides one private fixed-search-path/UTC reader with runtime EXECUTE only. All current credential rows across clients count, including archived/disabled/obsolete rows. Exact identity matching and complete retained-source keys remain mandatory. Normal observation permits exhausted active material; mutation preflight remains stricter. Declared restored observation refuses registered active material. No source registration, reservation, decryption, mutation or audit is introduced.

Output projects at most eight sorted source positions, active flags and decimal-string stored/eligible/excluded counts. Positions mean only the exact protected source ordering, never stable key IDs. All active-material rows are excluded from rotation eligibility. No labels, digests, registry IDs, budgets, ciphertext or provider/client/connection data leave the projection. One read-only transaction either completes under its ten-second bound or returns a fixed failure without partial counts; cancellation cleanup is separately bounded.

Counts are live observations only. They cannot authorize retirement, check backups/authenticate every blob, exclude future writers or detect undeclared rewind. Down/up removes/recreates only the entrypoint, preserves populated history and needs regranting; older populated guards remain intact. Full roundtrip now covers 21 versions.

See [operator inventory contract](../../docs/integration-key-inventory.md), [[Trusted One-Page Integration Rotation Command]], [[Protected Integration Key Startup and Declared Restores]], and [[Bounded Integration Credential Rewrap Batches]]. No production execution, provider access, merge or deployment is authorized by this slice.
