# Rust backend

`src/main.rs` runs native Pingora as the sole HTTP process and supplies bounded operator commands. `server.rs` serves the prebuilt frontend and security headers; `api*.rs` adapt unchanged versioned contracts to explicit transactional domain services. SQLite schema lives in `migrations/sqlite`; the PostgreSQL catalog and compressed fixture are import compatibility evidence only.

Use root `make backend`, `make dev-bootstrap`, `make check`, `make test-http`, `make test-import`, and `make test-cache`. The first two use private `.local/data`; tests own disposable storage. `make build` prepares static production artifacts before Docker.

Read [architecture](../notes/architecture.md), [domain contracts](../notes/domains.md), [providers](../notes/providers.md), and [recovery](../notes/operations.md) before changing persistence, permissions, exact arithmetic, provider work, or operator behavior. Never expose the synthetic SQL fixture helper or operator authority as a public API.
