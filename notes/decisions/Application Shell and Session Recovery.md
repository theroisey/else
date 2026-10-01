---
type: decision
status: pr-review
created: 2026-10-01
tags:
  - frontend
  - authentication
  - authorization
---

# Application Shell and Session Recovery

Issue #12 consumes the backend cookie-session and flattened-grant contracts. Auth stays same-origin; HTTPS reads only the host-prefixed CSRF cookie. Passwords clear after attempts and stay out of mutation caches/browser persistence. Go owns authentication audit records.

Initial load and identity lookup errors withhold protected content; 401/absolute expiry clears private cache and returns to login. Focus/reconnection/periodic/manual refresh updates grants. Failed logout retains the true state rather than claiming revocation. Return paths are allowlisted destinations held in router memory.

Only workspace/current access/login and existing public status/interface routes exist. Workspace/My access expose the caller's own identity, so no unrelated permission is invented. Future destinations require matching permission guards; backend authorization remains mandatory. Unknown keys and absent/wrong client scope deny. No business placeholder links or role-name checks exist.

Playwright is the single new test dependency, justified by real login/logout/expiry verification. A read-only CI job uses disposable PostgreSQL 18, reviewed migrations/runtime grants and synthetic test credentials without backend source/schema changes. Main publication depends on it. Raw cookies, traces, video and authentication request bodies are excluded; only safe synthetic UI screenshots are retained.

Local Docker Hub pulls remain rate-limited. Committed screenshots use intercepted visual fixtures, distinct from real CI API evidence. Never treat the fixture as a product/demo account or use it in an existing database.

- [[Identity and Sessions]]
- [[Authorization and Client Scope]]
- [[Interface Foundation]]
- [Application shell contract](../../docs/application-shell.md)
- [Issue #12](https://github.com/theroisey/else/issues/12)
