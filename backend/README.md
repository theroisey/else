# Backend

This directory owns the Go API and PostgreSQL persistence. HTTP/configuration/health infrastructure starts in [Issue #2](https://github.com/theroisey/else/issues/2). PostgreSQL connection and reversible migration tooling start in [Issue #4](https://github.com/theroisey/else/issues/4).

Use an idiomatic modular application. Separate HTTP transport, application services, domain rules, authorization, database access, audit writing, and provider adapters. Prefer the standard library and small dependencies with a demonstrated purpose; chi, pgx, and sqlc are options rather than an excuse to add every tool immediately.

Place the entry point under `cmd/api`, implementation domains under `internal`, and versioned schema changes under `migrations`. Do not create empty modules for later roadmap items.

Business endpoints use `/api/v1`. Every external input is validated, every resource lookup enforces permission and client scope, and significant successful mutations persist an audit event atomically. Money uses exact minor units or decimal arithmetic; timestamps use UTC.

Implement backend changes on `backend`. Root-level repository documentation and shared infrastructure may use a coordinated backend PR without unrelated frontend implementation. See [bootstrap instructions](../docs/repository-bootstrap.md).

Issue #2 adds the Go HTTP executable, configuration, structured logging, health/readiness, bounded shutdown, and focused unit/lifecycle tests. See [the HTTP foundation guide](../docs/backend-http.md) for configuration, response contracts, and run/check commands. Issue #4 adds PostgreSQL pools and reversible migrations; readiness checks real connectivity. Business routes are not implemented yet.

PostgreSQL uses pgxpool; schema changes use a separate embedded Goose migration executable. Export a securely provisioned runtime DATABASE_URL before API startup, and a distinct MIGRATION_DATABASE_URL for migration commands. See the [database guide](../docs/database.md) for role privileges, TLS, migration safety, and disposable integration tests.

Issue #7 adds typed append-oriented audit storage and a transaction helper for later mutations. See [the audit contract](../docs/audit-log.md) for allowlists, actor/correlation handling, explicit runtime grants and history-preserving rollback. No business mutation endpoint exists yet.

Issue #8 adds identity storage, a one-time administrator bootstrap, Argon2id passwords and revocable cookie sessions. See [the identity contract](../docs/identity.md) for API errors, cookie/CSRF/origin policy, throttling, runtime grants and bootstrap procedure. RBAC and client scope remain #9; the login UI remains #12.
