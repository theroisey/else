---
type: decision
status: in-review
created: 2026-10-03
tags:
  - security
  - testing
  - dependencies
---

# Implemented System Threat Review

Issue #98 under #30 adds an evidence-linked [implemented-system threat model](../../docs/security-review.md) and a compiled-API negative matrix. Owner closed #24; provider setup/OAuth/sync/remote revocation remain disabled and unfinished under #25–#27. Parent closure is not capability or security proof.

The matrix builds the real API, uses the production runtime grant source and disposable PostgreSQL, and proves route-family authentication, zero-grant denials, exact client isolation, four CSRF/Origin guard cases and current grant/session revocation. Positive reads distinguish live adapters from blanket failure. All ordinary application-table fingerprints remain unchanged around denial batches; errors/correlation/cache guards and synthetic input/token/password redaction are checked. Existing deeper domain/race/privilege tests remain the primary evidence for nested resources and transaction boundaries.

Current immutable official OWASP Authorization, CSRF, Session Management and Logging sources are linked in the guide. These support review, not certification. Residual risks remain explicit: per-process throttling needs edge controls; the current static server supplies no CSP/frame/HSTS policy; trusted owners/operators can bypass application data protections; undeclared database rewind cannot be detected; provider transport must be reviewed before activation; backup-key retention and deployment rehearsal are incomplete.

Historical local scan attempts on 2026-10-03 had no successful Go result because policy blocks `vuln.go.dev`; the full-history official snapshot build also failed on blocked downloads. No fabricated/incomplete database was used. Current #100/#102 / PR #101 has genuine CI evidence: all four pinned v1.8.0 symbol/package scans and npm audit pass at `1699b0a` in run 37155777513, with one visible unused OpenPGP module advisory explicitly dispositioned as non-applicable to compiled imports. All six checks pass; PR is ready for owner review. This updates the earlier missing-CI-result status without claiming the blocked local scan clean.

Current #103 / [[Frontend Browser Security]] supplies enforced nginx CSP/frame/nosniff/referrer headers, bundled icon CSS and JIT-free shared validation. Local built-artifact Chromium compatibility/attack denial passes. Actual nginx header checks and all six exact-head gates remain required, followed by #30 risk reconciliation. HSTS/TLS/edge/privilege/backup deployment evidence remains #32 work; the earlier missing-CSP finding is being corrected, not silently accepted.

- [[Remaining Roadmap]]
- [[Identity and Sessions]]
- [[Authorization and Client Scope]]
- [[Audit Infrastructure]]
- [[Protected Integration Key Startup and Declared Restores]]
- [[Official Provider Sources]]
