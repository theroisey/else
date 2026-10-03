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

On 2026-10-03 npm's full 306-entry lock audit found zero advisories. govulncheck v1.1.4 has **no successful Go result** because the enforced policy blocks `vuln.go.dev`. Building the official full-history vulndb snapshot (`5cd8418cf9c867d344fda07a73ea844b0f34bca2`, 2026-10-01) also failed on blocked dependency downloads; no fabricated/incomplete database was generated. Do not claim the scan clean or close #30 from this child. Verification outcomes belong in issue/PR metadata after the required five exact-head gates.

- [[Remaining Roadmap]]
- [[Identity and Sessions]]
- [[Authorization and Client Scope]]
- [[Audit Infrastructure]]
- [[Protected Integration Key Startup and Declared Restores]]
- [[Official Provider Sources]]
