---
type: decision
status: pr-open-for-review
created: 2026-10-01
tags:
  - architecture
  - database
  - security
---

# PostgreSQL Foundation

## Decisions

Issue #4 selects pgxpool and Goose's embedded, transactional SQL provider. The migration executable owns schema changes; the API owns only runtime connection lifecycle and actual readiness. The baseline creates app schema and revokes PUBLIC access, without business tables or speculative role/domain models. Rollback never cascades through later data.

API startup now requires explicit DATABASE_URL and successful connectivity. Migration tooling uses MIGRATION_DATABASE_URL with a separate identity. Runtime must not own the database/schema or receive migration privileges. Provisioning grants are documented and negative tests prove their boundary; actual deployment provisioning remains #5.

Explicit URL credentials, host/port/database, and TLS mode are mandatory. Non-loopback connections require verify-full. Ambient PGSERVICE fails closed, and implicit credential/certificate files are disabled. Runtime sessions use UTC and pg_catalog,app; migration sessions use UTC and pg_catalog,public. Logs expose only safe events/classifications.

Goose uses a dedicated advisory lock, transactional version changes, one-minute command deadline, statement/DDL lock bounds, and separately bounded unlock cleanup. Baseline down refuses a nonempty schema. Applied migration files are immutable. Metadata remains owned by the migration identity.

## Verification and environment

Docker Desktop was started with explicit tool approval for disposable PostgreSQL verification. Temporary containers use loopback ports, random credentials in protected temporary files, and memory-backed data. The repeatable script cleans up its own resources. No production URL or customer data was used.

Unit/race tests, actual PostgreSQL migration/permission/readiness tests, vet, formatting, native/static Linux builds, dependency vulnerability checking, and binary smoke checks verify this slice. Docker image builds, three-service orchestration, and CI remain #5/#6.

## Follow-ups

Issue #5 must respect the initial TLS contract for PostgreSQL container hostnames or explicitly scope a development transport adjustment. Later domains use TIMESTAMPTZ and explicit table grants; audit tables must not inherit blanket runtime write/delete grants. Connectivity readiness does not yet validate business schema versions because there are no business APIs.

## Related

- [[HTTP Foundation]]
- [[Frontend Foundation]]
- [Issue #4](https://github.com/theroisey/else/issues/4)
- [PR #36](https://github.com/theroisey/else/pull/36)
- [Database guide](../../docs/database.md)
