# PostgreSQL and migrations

Related Issue: [#4](https://github.com/theroisey/else/issues/4).

## Implemented contract

The API owns a bounded pgx connection pool using an explicit runtime `DATABASE_URL`. The separate migration executable uses `MIGRATION_DATABASE_URL`, pgx's database/sql adapter, and embedded Goose SQL migrations. The HTTP process never performs schema changes. Issue #7 adds [protected audit storage](audit-log.md); Issue #8 adds [identity/session storage](identity.md); Issue #9 adds [protected authorization storage](authorization.md); Issue #10 adds [guarded administration contracts](administration.md). Issues #13 and #15 add clients and tasks; #17 adds [plans, milestones and historical task links](planning.md) in migration 000008. #18 adds [one-time reminders and guarded lifecycle](reminders.md) in migration 000009. #22 adds the [guarded activity projection](activity.md) and one permission in migration 000010 without copying audit history.

Issue #19 adds [exact collections/payment storage](billing.md) in migration 000012, three granular billing permissions, private guarded readers/writer and deferred ledger/balance constraints. Payment rewrites and financial history removal are denied. Runtime receives only reviewed EXECUTE grants; populated financial/custom permission history refuses down. Empty down restores previous audit storage guards/reader filters.

Issue #21 adds [relational versioned pricing and immutable billing copies](pricing.md) in migration 000013. Exact per-line constraints, deferred totals/reference checks and immutable creation-transaction-bound lines retain history; copied collection amounts freeze immediately. Currency/permission catalogs and collection DTOs remain compatible. Runtime receives six guarded EXECUTE grants only. Empty down preserves finance/audit; retained pricing/snapshot/audit history refuses down.

Issue #23 adds the [authorized overview aggregate](client-overview.md) in migration 000014: one guarded entrypoint and a partial task deadline index. Runtime receives one EXECUTE grant; the permission catalog remains unchanged. Populated down/up preserves all business/audit history and requires regranting the recreated entrypoint. The overview migration itself leaves the permission catalog unchanged.

Issue #72 adds secret-free [connection metadata reads](integrations.md) in migration 000015, the client-defined integrations.view permission and an explicit Initial Administrator seed. Private relational ownership/account/state/revision/generation constraints and two guarded runtime EXECUTE grants keep account identifiers out of API responses. Runtime receives no metadata table privileges. Down takes the exclusive lifecycle lock and refuses any connection or custom/revoked view permission history. Recreated functions require reviewed runtime grants before API rollout.

Issue #74 adds private per-key encryption accounting in migration 000016. Immutable labels/material fingerprints and monotonic reservations cap the reviewed backend Seal/Rewrap path at 2^24 allocations per key in one authoritative database. Two guarded functions require current clients.view plus integrations.manage; runtime gets EXECUTE only. A typed reservation audit commits before encryption, then a fresh binding transaction holds the lifecycle lock through crypto. Any budget or reservation audit history refuses down; empty accounting roundtrip is verified and recreated functions require regranting. After counter-rewinding restore/clone, fresh independent keys are mandatory before encryption; this module cannot detect restore automatically. No keys/plaintext/ciphertext or API startup wiring are added. See [integration operations](integrations.md).

Issue #76 adds private encrypted credential storage in migration 000017. A bounded access-token envelope belongs permanently to one connection and references an immutable encryption-budget identity. Positive credential revisions/generations, guarded exact-client reads and exclusive-lock CAS writes fence stale replacement/rewrap. Replacement advances generation; key rewrap preserves it. Both advance connection and credential revisions and atomically emit safe typed audits. Runtime gets two EXECUTE grants only, no table/helper access. Any credential row or matching credential audit refuses down; empty rollback preserves metadata/budgets, and recreated functions require regranting. The credential slice verified seventeen versions; migration 18 below advances the full empty roundtrip to eighteen versions. No HTTP credential route or startup keys are supplied; restore enforcement remains an operator prerequisite. See [private credential operations](integrations.md).

API startup now requires valid database configuration and a successful real connection check. This intentionally replaces Issue #2's unconfigured executable: configure PostgreSQL before starting the API. Invalid/missing settings or unavailable startup dependencies exit with a safe structured error. Once serving, `/health` remains process liveness and `/ready` calls the real pool with the existing request deadline. An outage produces readiness 503 while liveness remains 200; reconnecting restores readiness.

Readiness currently verifies connection availability, not domain-table compatibility or provider health. The deployment sequence must apply migrations and reviewed runtime grants before starting a version that needs them; identity and administration APIs require their schema contracts.

The [client contract](clients.md) adds migration 000006: real client/contact/tag relations, preserved legacy scope IDs and a foreign key for existing role assignment history. New scoped assignments require an active client. Scope-only rollback preserves old grants; populated rollback is refused. Apply owner migrations and reviewed runtime EXECUTE grants before serving the client API.

The [task contract](tasks.md) adds migration 000007: relational tasks/tags, explicit transitions and timestamp consistency, scoped assignee enforcement, granular capability definitions and safe task audit markers/actions. Populated task/audit or changed granular assignment history blocks rollback. Existing client history survives an unused-task down/up cycle. Drain writers for migration DDL and reapply narrow runtime grants before serving the task API.

## Configuration and credentials

Issue #78 adds confirmed local disconnect in migration 000018. One fixed-search-path/UTC guarded function takes the exclusive lifecycle lock before fresh three-permission/ownership/revision checks. State/revision/generation fencing and a safe HTTP-source audit commit together; ciphertext/budgets/history are retained. Runtime receives only its EXECUTE grant. Removing/recreating this entrypoint preserves populated data/audits and requires regrant. It changes no permission catalog, credential schema or stored lifecycle enum, and sends no provider request. That slice verified eighteen migration versions.

Issue #82 adds migration 000019, a private boolean key-preflight capability. Configured API startup runs it read-only under the shared lifecycle lock before listening, checking permanent identities, retained current-row keys and active capacity. Declared `restored` mode additionally requires an unregistered active identity; it cannot detect undeclared snapshot rewind or prove external key freshness. Only runtime EXECUTE is granted; PUBLIC and direct registry/credential access remain denied. Down/up removes/recreates only the capability and preserves populated history, with regrant required. That slice verified nineteen versions. See [key configuration and restore limits](integration-key-startup.md).

Issue #84 adds migration 000020, one private exact-client candidate reader for bounded rewrap pages. Shared lifecycle locking protects fresh management/client checks; only UUID/revision/generation checkpoints are projected. Runtime receives EXECUTE only; populated down/up preserves history and requires regrant. That slice verified twenty versions. The [rotation service](integration-rotation.md) preserves generations and stops on errors with honest partial progress, using existing per-row audits/budgets; no global retirement proof is supplied.

Issue #90 adds migration 000021, a private read-only [live key retention inventory](integration-key-inventory.md). Both current global clients.view and global integrations.manage are mandatory even when empty. Shared lifecycle locking precedes grants and complete source/identity checks. The projection contains bounded source positions, active flags and stored/eligible/excluded counts only. Normal inventory permits exhausted active material without weakening writer preflight; restored inventory still rejects registered active material. Runtime receives EXECUTE only. Down/up preserves populated storage, accounting and audits and requires regrant. Full empty migration roundtrip now includes twenty-one versions. No permission, mutation, audit event, provider call or key retirement proof is added.

Export the relevant secret URL from environment-specific secret management, without printing it. URLs require an explicit `postgres`/`postgresql` scheme, username, nonempty password, host, numeric port, database name, and exactly one `sslmode`. Percent-encode credentials containing URL-special characters.

Use `sslmode=verify-full` outside literal loopback/localhost. `sslmode=disable` is accepted only for loopback development. Optional `sslrootcert` may name a backend-mounted trusted CA file. Other URL query settings, ambiguous duplicate keys, fragments, credential overrides, and service-file options are rejected. The application never loads .env files automatically.

Connection parsing rejects ambient `PGSERVICE`; URL identity cannot silently fall back to a service or password file. Ambient certificate files are disabled unless the explicit URL supplies `sslrootcert`. Session runtime parameters are replaced with explicit UTC, a fixed application name, and `pg_catalog,app` search path (migration connections use `pg_catalog,public`). No query tracer logs SQL or arguments.

The runtime pool has at most 10 connections, zero required idle connections, five-second connection/startup timeouts, 30-minute maximum connection lifetime, and five-minute maximum idle time. [#109 runtime budgets](runtime-budgets.md) set a five-second statement timeout, two-second lock timeout and ten-second idle-in-transaction session timeout on API/runtime connections. These server bounds complement request-context cancellation and cannot be disabled by ambient PGOPTIONS. Migration connections retain one SQL connection, UTC, 30-second statement timeout, five-second DDL lock timeout, and a one-minute command deadline; they do not inherit runtime idle-transaction settings. Advisory-lock cleanup has a separate two-second bound.

These initial TLS rules also apply to non-loopback Docker hostnames. Issue #5 must provide tested TLS for shared container networking or explicitly document and scope a development-only transport change; it must not silently weaken this contract.

## Role provisioning

Provision identities outside ordinary application startup. A trusted administrator can use the following role/database pattern; assign distinct passwords through a secure provisioning channel rather than committing them or passing them as process arguments:

```sql
CREATE ROLE else_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE else_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE "else" OWNER else_migrator;
REVOKE ALL ON DATABASE "else" FROM PUBLIC;
GRANT CONNECT ON DATABASE "else" TO else_migrator, else_runtime;
```

Connect administratively to the new `else` database and revoke public schema grants:

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO else_migrator;
```

Set the migrator password interactively with psql `\password else_migrator` and the runtime password with `\password else_runtime`, or use approved secret provisioning. Export the corresponding URLs privately. Run migrations with the migration identity. After migrations, apply the reviewed audit, identity and authorization grants in [the audit guide](audit-log.md), [identity guide](identity.md) and [authorization guide](authorization.md). Local Compose uses:

```sh
docker compose exec -T postgres psql -U postgres -d else < backend/scripts/grant-runtime.sql
```

The migrator owns the database, `app` schema, and Goose metadata; runtime must not be a database owner, superuser, schema creator, or member of the migration role. Application code does not elevate the supplied role. Operators must enforce these grants. Tests prove a correctly provisioned runtime role can connect but cannot create schemas/tables or read/update migration history.

Do not use default blanket table grants. Each later domain migration grants the runtime only the operations needed for its actual tables; audit integrity needs stricter grants than normal business records. No runtime privileges on `public.goose_db_version` are required for a connectivity check.

## Commands and lifecycle

From `backend/`, with Go 1.27.1 and secret variables already exported:

```sh
go run ./cmd/migrate status
go run ./cmd/migrate up
go run ./cmd/api
```

The migration executable accepts only `up`, `down`, or `status`; URL arguments are not accepted. `up` applies pending migrations and repeated successful runs are no-ops. `down` reverts exactly the latest applied migration. No-current-version rollback fails visibly. Status reports numeric versions and pending/applied state without SQL or credentials.

Goose status may initialize its version metadata table, so even status uses the migration identity. Metadata lives at `public.goose_db_version`; SQL sources are embedded from `backend/migrations/`. Deterministic six-digit names such as `000001_create_app_schema.sql` contain both `-- +goose Up` and `-- +goose Down`. Applied files are immutable: add a new migration instead of editing shipped history. Out-of-order migrations and global Go migration registration are disabled.

The baseline creates only `app` and revokes PUBLIC schema access. Up fails if an untracked schema already exists rather than silently adopting it. Down uses `DROP SCHEMA app` without CASCADE. It can remove the empty baseline; a nonempty schema blocks rollback and preserves its objects/data and applied version. Later domain rollback/data-removal policy belongs to that domain's reviewed Issue.

Migration execution and version updates are transactional. PostgreSQL session advisory locking serializes migration processes. A failed statement rolls back that migration without advancing its version; previously applied migrations remain intact. Lock cancellation is observable and a later attempt can succeed after release.

Diagnostics expose fixed events and safe error classifications such as permission_denied, schema_not_empty, deadline_exceeded, or authentication_failed. Internal errors preserve causes where appropriate; raw driver errors, SQL, URLs, passwords, and library diagnostics are never printed. Pool resources close after HTTP draining. Migration connection resources close after command completion/failure.

Future domain timestamps should use TIMESTAMPTZ and UTC persistence/API semantics. Goose's migration metadata uses the library's pinned schema and UTC migration sessions; this baseline does not invent business timestamp columns.

## Disposable integration verification

The [recovery runbook](recovery.md) documents actual logical backup/restore and a pinned previous/current API compatibility rehearsal, including retained-key, private-grant, checkpoint and rollback limits. Its tagged test requires the owned matching PostgreSQL container exported by the standard runner and reviewed Git history; an external test URL alone is insufficient for the complete suite.

Run normal formatting/vet/unit checks as documented in the [HTTP guide](backend-http.md). With Go, Docker, and openssl available:

```sh
sh scripts/test-integration.sh
```

The runner creates its own PostgreSQL 18.3 container pinned by digest, loopback-only random port, memory-backed data, random password in a mode-600 temporary file, and unique temporary databases/roles. It runs integration race tests and removes its container and credential file on exit. It ignores external database URLs. The server timezone is deliberately non-UTC so the tests prove application/migration UTC defaults rather than relying on server defaults.

Alternatively, explicitly export `TEST_DATABASE_URL` for a disposable PostgreSQL administrator database and run:

```sh
go test -race -tags integration -count=1 ./tests/integration
```

This administrator must be able to create/drop the uniquely named test databases and roles. The tagged suite fails if no test URL is supplied; it never silently skips database proof. Never point it at a customer or production server. Tests create/drop only their generated fixtures.

Coverage includes up/no-op/down/up, migration states, UTC sessions, transaction failure and retry, preserved data after refused rollback, cross-session lock contention/cancellation/recovery, negative runtime privileges, bounded startup failure, and real HTTP readiness through a database outage/recovery. Binary smoke checks also verify separate migration/runtime identities, safe process logs, and graceful SIGTERM shutdown.

Three-service development orchestration and local runtime-image verification are proposed in #5; [the Docker guide](docker.md) preserves verified TLS and documents explicit migration/role steps and current verification blockers. GitHub Actions gates remain #6. Running a PostgreSQL test container does not constitute a passing application Docker build or production deployment.

## References

- [Goose migration provider](https://github.com/pressly/goose)
- [pgx connection pools](https://pkg.go.dev/github.com/jackc/pgx/v5/pgxpool)
- [PostgreSQL session defaults](https://www.postgresql.org/docs/current/runtime-config-client.html)
