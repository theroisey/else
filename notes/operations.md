# Deployment and recovery

## Current runtime

Use the fixed `ghcr.io/theroisey/else:latest` image, Compose service/container `else`, and named volume `roisey-else-data`. Rust/Pingora PID 1 is the sole HTTP server and explicitly owns one private Redis child. Local deployment publishes only 127.0.0.1:8080; `.env.example` exposes only `APP_PORT`, `AUTH_PUBLIC_ORIGIN` and `AUTH_COOKIE_SECURE`. Public ingress requires the exact HTTPS origin and secure cookies. Package authentication belongs to the Docker host.

The scratch image runs UID/GID 65532, read-only root, no capabilities and no-new-privileges. `/tmp` is a bounded nonpersistent 16 MiB tmpfs. The image's explicit named data directory is owned by 65532:65532 with mode 0700; a fresh Docker volume inherits it. Existing nonempty storage is not automatically reowned. Preserve wrongly owned data, inspect its metadata and use trusted host maintenance before retrying; the app never starts as root or weakens permissions.

Durable state lives under `/var/lib/roisey-else`: `else.sqlite3`, its transient SQLite WAL/SHM companions, `.control/runtime.lock`, retained encryption keys and supported backups. Native development can set absolute `DATABASE_PATH`, `FRONTEND_DIRECTORY` and numeric `HTTP_ADDRESS`. The standard deployment automatically provisions `.control/integration-keyring.json`; explicit retained sources and `INTEGRATION_KEYRING_MODE=restored` remain native recovery controls. A previously used key cannot be declared fresh.

Redis is automatic at 127.0.0.1:6379 inside the same container. No separate service, host port, configuration URL or durable Redis files exist. Save/AOF are disabled; memory is capped at 64 MiB with allkeys-lru. It cannot own sessions, permission decisions, finance, jobs or leases. Bounded cache misses/stalls read from SQLite. Redis startup failure exits nonzero; unexpected child exit fences readiness and gracefully terminates Rust nonzero, enabling Compose's unless-stopped whole-container restart.

`/health` is process liveness. `/ready` requires a non-draining process, SQLite and an independent bounded Redis PING. `/roisey-else health` is the native readiness probe. Docker probes every 30 seconds after a 20-second startup grace, with early two-second probes and three failures. Unhealthy state alone does not restart Docker; an unexpected process exit does. Structured JSON logs expose fixed stages/codes and safe filesystem operation/kind/errno or owner/mode metadata, never private paths, SQL, key bytes, credentials or provider payloads.

Normal startup logs: `application_starting`, `data_directory_ready`, `embedded_redis_starting`, `embedded_redis_ready`, `database_ready`, `migrations_ready`, `keyring_ready`, `frontend_ready`, `server_listening`. Stage failures identify storage/control/lease, Redis, database/WAL/migrations, keyring, frontend, provider trust or listener initialization. Shutdown stops/reaps the child; no external process supervisor or registry polling is installed.

## Operator commands

`/roisey-else help` lists serve, health, migrate, bootstrap, backup, restore, key-inventory and rotate-credentials. Bounded JSON input rejects duplicate/unknown fields. The root Makefile provides these workflows. Operator authority is trusted filesystem/container access, not merely supplying an actor ID; actor IDs record audit attribution. Protect input and output. Bootstrap runs once; it does not recover a forgotten existing administrator.

Updates use `make update` or Compose pull/recreate and retain the fixed volume. `make down` never deletes it. Use compatible artifact rollback only after checking SQLite schema/provider compatibility; no automatic downgrade or deletion of retained history is permitted. CI promotes the saved tested image, signs/verifies its digest and source, then pulls and rechecks it. Publication does not authorize production deployment.

## Supported backup

Use `make backup BACKUP_NAME=checkpoint` while serving. SQLite's online backup API creates a consistent standalone snapshot and validates integrity, foreign keys, exact payment/pricing histories, counts and authenticated ciphertext. The bundle includes `database.sqlite3`, `keyring.json` and `manifest.json`; it publishes atomically without replacing an existing checkpoint. Native invocations never copy the actively written main file as a backup.

Copy the complete bundle from `else:/var/lib/roisey-else/backups/checkpoint` to private encrypted off-host storage. Retain every needed decryptor with backup policy; a live key inventory cannot authorize key retirement for older checkpoints. Never upload production bundles, databases or key material as CI evidence.

## Supported restore

Restore on a recovery host with **empty fixed storage**, before its first `make up`. Preserve the original installation and off-host bundle. Run `make restore BACKUP_SOURCE=/absolute/private/checkpoint`, then validate with `make up`. An existing populated installation is refused; this workflow does not erase it or expose production volume selection.

The host wrapper requires an operator-owned private 0700 source directory and three single-link regular files in mode 0400/0600. It refuses a running application and uses Docker's archive API to stage exact bytes with UID/GID 65532, without running a root process. Native restore holds the exclusive volume lease, writes a durable pending marker before verification, opens the source READ_ONLY/query-only, verifies every retained history and ciphertext, and introduces independent fresh active encryption material. Atomic no-replace publication installs keys before the database and removes the pending marker only after verification. Staged bundles stay private on the recovery volume.

A rejected/interrupted verification leaves startup blocked by `restore_incomplete`. Preserve that target for investigation and prepare another empty recovery host/storage explicitly. Never remove the marker to force serving. A full eight-key ring needs reviewed retention/rotation before recovery can add a key; no required decryptor is dropped. Snapshot bundles must match the supported SQLite schema; take a new supported checkpoint after an additive schema upgrade. Ordinary existing SQLite databases upgrade through immutable checksum-verified migration records.

Before releasing recovered traffic, reconcile post-checkpoint revocations, disabled users, credentials, exact financial commands and external effects. Restored sessions/grants are checkpoint facts. Validate permitted/denied operations and exact finance/audit/history counts under the accepted artifact. Preserve the original source/bundle/keys under policy. This procedure alone does not establish production RPO/RTO or mass-revoke sessions.

## Verification ownership

Runtime, capacity and Compose harnesses own random disposable resource names and free loopback ports. Fixture-only Compose overrides replace image/container/volume names internally; the production configuration stays fixed. Test cleanup targets only those owned resources. Synthetic helper binaries are prepared outside Docker and never copied into the production image.
