# Production operation

The user's 2026-10-05 architecture direction supersedes the former separate managed PostgreSQL / multiple API deployment under existing [#32](https://github.com/theroisey/else/issues/32). The standard deployment is one complete Docker container with PostgreSQL, Go-served React/API, and a supervised worker. Choose a persistent Docker host with durable storage and external HTTPS ingress. Ordinary Vercel/static/serverless Node hosting cannot run it unchanged. Publishing an image does not provision infrastructure or release traffic.

## Host and configuration

Start with a measured host budget (for example 2–4 vCPU, 4–8 GiB RAM, and SSD/block storage), then size from representative load and database growth. This is a starting estimate, not a benchmark or SLA. Target 50–100 initial clients, growth to 500+, 20–50 initial users and readiness for 100+ concurrent users. Keep free disk space for WAL, image replacement, and backup staging; alert before exhaustion.

Pin a verified `ELSE_IMAGE` digest, preserve `ELSE_DATA_VOLUME`, configure exact external HTTPS `AUTH_PUBLIC_ORIGIN`, and set `AUTH_COOKIE_SECURE=true`. Terminate TLS in existing host/platform ingress and forward to the loopback app port. Retain edge throttling, bounded requests, safe logs, and host access controls. No extra ingress container is part of the standard Compose distribution.

Do not replicate containers over the same database volume. A filesystem lock prevents competing writers. This topology scales vertically and requires a maintenance interruption for image replacement. Future independent web replicas require an explicitly approved topology change, rather than bypassing this lock.

## Runtime budget and health

The API pool is bounded at 10 connections, worker at 2, and migrator at 1. Background provider sync uses durable leases, bounded results, and existing global concurrency limits. Reports remain database reads; dashboard requests never wait on provider synchronization. Existing indexed/paginated queries, bounded caches, timeout validation, session storage, and exact authorization remain intact.

`/health` is API liveness and `/ready` checks database connectivity within a deadline. Container health executes the bundled healthcheck. The supervisor additionally watches every required process and exits on PG/API/worker death; migrations/key validation must pass before normal startup. Configure alerts for unhealthy/restarting containers, worker job failures, disk space, database connections/locks, CPU/memory, HTTP error/latency rates, and backup age. Avoid raw environments, SQL parameters, credentials, or customer bodies in operational logs.

Existing 500-client/100-session synthetic capacity rehearsals validate business query behavior. They do not measure this complete deployment's sustained latency or establish availability/recovery targets. Run representative dashboard/CRUD/provider load on the selected host, record P50/P95 and error rates, and confirm common interactions meet the desired 1–2 second target.

## Upgrade and rollback

Back up database and keys off-host, verify restoration, select the intended revision/digest and schema compatibility, then use a maintenance window. `docker compose pull` and `docker compose up -d --wait` retain the volume and run only pending migrations before starting API/worker. Check current release stamps, representative allowed/denied operations, finance/audit history, and worker operation before routing traffic.

Startup does not downgrade PostgreSQL or remove migration history. An old application image may be incompatible with a newer schema; choose a tested compatible artifact or perform a controlled offline restoration. Do not run automatic destructive down migrations or use `down --volumes` as rollback. See [adoption](docker.md#existing-installation-adoption) and [recovery](recovery.md).

## Backup and custody

Schedule protected logical archives using `/opt/else/operator backup`, separately escrow retained encryption keys, encrypt off-host storage, and set ownership, retention, restore frequency, RPO and RTO. A live filesystem copy of PGDATA is not a safe backup. Whole-volume snapshots require clean shutdown or a PostgreSQL-aware physical backup procedure.

Restore to a separate volume while every writer remains offline. Supply retained decryptors and never-used active encryption material, run the explicit offline import/verification path, verify financial/audit/migration/key history, then obtain rollout authority before opening production traffic. Failed restore verification leaves normal startup blocked.

## Release checklist

Confirm all six exact-revision CI gates and tested-image publication; host storage and backups; exact HTTPS origin and cookies; health and graceful stop; restricted runtime privileges; approved first administrator; required provider account access; backup restore rehearsal; measured capacity; safe monitoring and named incident ownership. Keep actual target measurements and rollout decisions separate from source/CI evidence.

## Idle operation refinement (#133)

Docker probes readiness every 30 seconds after startup, with a 3-second command timeout and 3 consecutive failures. Startup retains 120 seconds of grace and probes every 5 seconds during that period; a successful early probe ends grace. Normal unhealthy detection is approximately 60–90 seconds after readiness fails (up to about 99 seconds including timed-out probes). The Go healthcheck has its own 2-second HTTP timeout. This cadence reduces idle database work while the supervisor still detects required-process death every second and exits immediately. Docker does not restart solely because health status is unhealthy; `unless-stopped` acts on container exit. Existing retained-database startup/migration/recovery and persistence checks remain required.

The browser no longer polls sessions every minute. Absolute session expiry clears identity and private caches on its timer; focus/reconnect and explicit access refresh revalidate. Every protected backend request still checks current session/permissions, and 401/403 responses refresh frontend access and remove revoked data. An otherwise untouched idle tab discovers server-side revocation on its next focus/reconnect/protected operation, rather than promising continuous revocation push. No expiry or logout contract changed.

The final capacity rehearsal exposed repeated role/permission joins for every client-directory candidate. Migration `000028_client_directory_grants.sql` evaluates current `clients.view` grants once within the statement snapshot and applies the same global/client visibility predicate. It preserves input validation, literal search, tags, archive filters, keyset ordering, document fields and runtime function privileges; no table, column, index, permission catalogue or HTTP contract changes. Grants are never cached between requests. Down restores the previous function body; deployment uses the existing automatic pending-migration path. Regression coverage compares old/new results and privileges across rollback/reapply and verifies immediate visibility changes after grant revocation. The existing two-second capacity limit remains unchanged.
