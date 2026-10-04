---
type: decision
status: in-review
created: 2026-10-04
tags:
  - identity
  - readiness
  - availability
---

# Bounded Password Work

#111 under #32 adds one two-slot synchronous password-work limiter shared by actual API identity/admin services. Existing Argon2id 19MiB/two-iteration/one-lane policy and unknown/disabled/wrong-password behavior stay unchanged. No queue or CPU work escaping its slot; cancellation is checked before admission and after computation, while live work keeps its slot until stopped.

Full admission gives fixed safe 503 service_busy/Retry-After 1 with no account details, cookie, mutation or successful audit. Legacy Passwords compatibility remains; actual API services receive the same bounded instance. CLI bootstrap remains a separate invocation with context checks. Two workspaces are about 38MiB, not a whole-process memory ceiling. Edge/distributed limits remain required.

Deterministic admission/cancellation/error/panic tests and actual Argon compatibility pass. Real PostgreSQL/handlers control scheduling alone, preserve actual credentials/SQL, prove busy known/unknown login and admin nonmutation via fingerprints, then recover with exact sessions/users/audits. The targeted identity/admin/compiled-denial PostgreSQL run passed in 12.200s; all Go race tests, ordinary/integration vet and static builds passed. The [guide](../../docs/password-work.md) records effects/limits; all six final-head CI gates and owner review remain required. No production/crypto/privacy certification.

- [[Remaining Roadmap]]
- [Separately reviewed runtime budgets #109](https://github.com/theroisey/else/issues/109)
- [[Identity and Sessions]]
