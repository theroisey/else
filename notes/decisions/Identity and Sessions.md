---
type: decision
status: implementation-in-progress
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

Local Go checks and tagged PostgreSQL-suite compilation precede actual CI evidence. Docker Hub's unauthenticated pull limit blocks local runtime execution. See [the identity contract](../../docs/identity.md), Issue #8 and the eventual PR for final evidence.

- [[Audit Infrastructure]]
- [[PostgreSQL Foundation]]
