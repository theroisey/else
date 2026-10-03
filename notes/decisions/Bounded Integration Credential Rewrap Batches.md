---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - backend
  - security
  - database
---

# Bounded Integration Credential Rewrap Batches

Issue #84 follows owner-merged #82 / PR #83 at `26b312ad0ca3d4e7de96b7b3ceaee5e0f5ebe79c`. Final-head CI 37126956605 and main CI 37127583727 passed all five gates; both permanent branches synchronized before code. The issue records actor/client permissions, eligibility, partial progress and retention policy first. Parent #24 stays open.

Private rotation.Run selects at most 100 exact-client credentials plus one lookahead in canonical UUID order. Migration 20's fixed-search-path/UTC SECURITY DEFINER function takes the shared lifecycle lock before fresh clients.view plus integrations.manage checks, even for empty pages. Only active-client eligible Meta Ads rows with current credential generation and nonactive material are selected. It projects UUID/revision/generation checkpoints without envelopes/accounts/key identities; EXECUTE is the only runtime grant and PUBLIC remains denied. Down/up preserves populated history and requires regrant.

The trusted source owner enforces protected loading and declared restore startup; each page repeats normal key preflight before writing. All current-row keys remain required, including excluded disabled/obsolete material. A thirty-second work deadline honors parent cancellation, with the existing separate transaction cleanup bounds. Planning releases its connection before sequential audited vault rewraps; captured checkpoints, fresh authority/state and full CAS fence every row. Generation/provider state remain unchanged and existing per-row audits commit with storage. Reservations commit before crypto and are never refunded.

The first failure stops the page without automatic retry. Results contain only known commits, last confirmed cursor, first failed/pending UUID and page/lookahead flags. They never advance past an uncertain row. Earlier commits remain; reconcile explicitly before a new request. Restarted scans exclude material already active. Cursors are caller-owned, not durable snapshot certificates; reset on client/key changes or concurrency behind them. No scheduler/CLI/public route/credential acceptance/provider request is added.

Eligible completion cannot authorize retirement: disabled/obsolete/other-client and backup-only ciphertext remain, concurrency can change candidates, and stale writers require external exclusion. Broader inventory/backup expiry and verified restore proof remain future work. Automatic restore detection and provider lifecycle remain incomplete. See [batch operating contract](../../docs/integration-rotation.md). Full backend/real PostgreSQL and final-head five-gate CI accompany owner review; no agent merge or deployment.

- [[Protected Integration Key Startup and Declared Restores]]
- [[Encrypted Integration Credential Persistence]]
- [[Durable Integration Encryption Budgets]]
