# Rust backend

`src/main.rs` runs native Pingora as the sole HTTP process and PID 1. It starts, probes, monitors, stops and reaps one embedded private Redis child. `server.rs` serves prebuilt frontend assets, security headers and health endpoints; `api*.rs` adapt versioned contracts to explicit transactional domain services. SQLite schema lives in `migrations/sqlite` and remains the sole durable authority.

Use root `make backend`, `make dev-bootstrap`, `make check`, `make test-http`, and `make test-cache`. Native serving and cache tests use the prepared Redis artifact and its packaged musl loader; development needs no resident Redis service. `make build` prepares all production artifacts before Docker. Operator commands such as bootstrap, backup and restore do not start Redis or HTTP.

Read [architecture](../notes/architecture.md), [domain contracts](../notes/domains.md), [providers](../notes/providers.md), and [recovery](../notes/operations.md) before changing persistence, permissions, exact arithmetic, provider work, or operator behavior. Never expose synthetic fixture helpers or operator authority as a public API.
