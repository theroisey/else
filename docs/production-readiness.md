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
