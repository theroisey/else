---
type: decision
status: pr-review
created: 2026-10-01
tags:
  - authentication
  - database
  - security
---

# Identity and Sessions

Issue #8's password, session, cookie, CSRF, throttle, trusted-proxy and bootstrap decisions were recorded before implementation. Passwords use bounded Argon2id PHC strings; opaque session and CSRF values are independently random and stored only as SHA-256 digests. Sessions expire absolutely after 12 hours and logout revokes rather than deletes.

Unsafe requests require exact configured Origin; authenticated mutations also match a session-bound CSRF header/cookie. Secure HttpOnly/Strict cookies are the default, with an explicit loopback-only HTTP mode. Forwarded headers are ignored. A bounded in-process limiter supplements edge/distributed controls and logs no identifiers.

Runtime database access uses narrow security-definer lookup functions and explicit column grants. It cannot bulk-read users, hashes or tokens; insert users; alter the bootstrap marker; or delete identity history. Login/session mutations use the audit transaction helper. Failed logins have no database mutation and emit only fixed safe log events.

The interactive migration-owner bootstrap succeeds only on an empty user table and creates a single marked identity plus atomic audit. The marker is not authorization; #9 consumes it into RBAC. No self-registration, recovery, MFA, roles, client scope or frontend UI enters this slice.

Local module/format/vet/race/static-build and tagged-suite compilation checks pass. CI run 36865279033 passes all four actual gates for `0fa3130ca1edd6f5796f20d1fbfceba4ef68c4f2`, including PostgreSQL identity/rollback/permission tests and full Compose development/static runtime verification. Publication correctly skipped on the PR. Docker Hub's unauthenticated pull limit still blocks local runtime execution; GitHub supplied the evidence. PR #42 awaits owner review/merge.

- [[Audit Infrastructure]]
- [[PostgreSQL Foundation]]
- [PR #42](https://github.com/theroisey/else/pull/42)
- [Verified CI](https://github.com/theroisey/else/actions/runs/36865279033)
