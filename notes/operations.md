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

Production frontend builds register `/sw.js` on secure origins. Waiting service worker updates activate after all controlled application tabs/windows close; no forced reload discards drafts. Browser Cache Storage contains only bounded public immutable assets, never customer records or queued writes. Changes to worker cache policy must increment its application-owned cache version. If removing service worker support later, ship a network-only replacement at the same `/sw.js` URL for installed clients rather than only deleting the script.

## Supported backup

Use `make backup BACKUP_NAME=checkpoint` while serving. SQLite's online backup API creates a consistent standalone snapshot and validates integrity, foreign keys, exact payment/pricing histories, counts and authenticated ciphertext. The bundle includes `database.sqlite3`, `keyring.json` and `manifest.json`; it publishes atomically without replacing an existing checkpoint. Native invocations never copy the actively written main file as a backup.

Copy the complete bundle from `else:/var/lib/roisey-else/backups/checkpoint` to private encrypted off-host storage. Retain every needed decryptor with backup policy; a live key inventory cannot authorize key retirement for older checkpoints. Never upload production bundles, databases or key material as CI evidence.

## Supported restore

Restore on a recovery host with **empty fixed storage**, before its first `make up`. Preserve the original installation and off-host bundle. Run `make restore BACKUP_SOURCE=/absolute/private/checkpoint`, then validate with `make up`. An existing populated installation is refused; this workflow does not erase it or expose production volume selection.

The host wrapper requires an operator-owned private 0700 source directory and three single-link regular files in mode 0400/0600. It refuses a running application and uses Docker's archive API to stage exact bytes with UID/GID 65532, without running a root process. Native restore holds the exclusive volume lease, writes a durable pending marker before verification, opens the source READ_ONLY/query-only, verifies every retained history and ciphertext, and introduces independent fresh active encryption material. Atomic no-replace publication installs keys before the database and removes the pending marker only after verification. Staged bundles stay private on the recovery volume.

A rejected/interrupted verification leaves startup blocked by `restore_incomplete`. Preserve that target for investigation and prepare another empty recovery host/storage explicitly. Never remove the marker to force serving. A full eight-key ring needs reviewed retention/rotation before recovery can add a key; no required decryptor is dropped. Snapshot bundles must match the supported SQLite schema; take a new supported checkpoint after an additive schema upgrade. Ordinary existing SQLite databases upgrade through immutable checksum-verified migration records.

Before releasing recovered traffic, reconcile post-checkpoint revocations, disabled users, registered-mailbox recoveries, credentials, exact financial commands and external effects. Restored sessions/grants are checkpoint facts. Validate permitted/denied operations and exact finance/audit/history counts under the accepted artifact. Preserve the original source/bundle/keys under policy. This procedure alone does not establish production RPO/RTO or mass-revoke sessions.

## Verification ownership

Runtime, capacity and Compose harnesses own random disposable resource names and free loopback ports. Fixture-only Compose overrides replace image/container/volume names internally; the production configuration stays fixed. Test cleanup targets only those owned resources. Synthetic helper binaries are prepared outside Docker and never copied into the production image.

## Operational automation and schema upgrades

Additive migrations `000003_operations`, `000004_commercial_finance`, `000005_recurring_operations`, `000006_dashboard_attention_indexes`, `000007_session_refresh` and `000008_mcp_bridge` extend existing identities/tasks/collections with request evidence and reviews, team-managed grants, service terms/periods/transfers/reversals, recurring versions/occurrences and notification state, plus opaque refresh generations for new authenticated logins and scoped MCP delegation, exact approval intents and retained command receipts. Existing payment collectors remain NULL rather than inferred. Do not edit a migration already applied to an installation. There is no automatic downgrade: rolling code back requires an artifact compatible with schema 10, or a separately rehearsed empty-target checkpoint restore with post-checkpoint reconciliation.

Private screenshots and documents are database BLOBs and travel with supported backups. Recovery verifies request/task state and delivery/review sequences, commercial source amounts/collectors/net reversals, recurring identities/versions and all foreign keys. Take a fresh verified checkpoint after upgrade; older snapshot schemas cannot be directly restored with a mismatched artifact.

The existing Rust worker runs automation without an external cron. It examines bounded queues (25 task templates and 25 agreements per work cycle), uses durable unique identities and rechecks current managers. It checks ordinary due work every 30 seconds, continues a nonempty backlog on a short bounded interval and backs off a failed schedule for five minutes. Paused/cancelled schedules do not generate. Catch-up over 62 days requires explicit authorized reconciliation rather than unlimited backfill; no bulk historical billing endpoint is supplied. See [operations platform](operations-platform.md) for remediation.

Native serving/tests share the fixed private loopback Redis port 6379: run native HTTP/browser/cache gates serially and preserve unrelated listeners. Docker fixture containers have independent network namespaces. Production still has one application container. Passwordless login requires SMTP configuration as described in [authentication](authentication.md).

Frontend releases use revalidated HTML/bootstrap/worker scripts and immutable code/font files. Keep the complete checked build together in the image. Save work and close old panel tabs so a waiting worker can activate after deployment. An explicit startup recovery action handles an unavailable entry file without automatic reload loops. Never clear unrelated browser caches or unregister unknown workers as a blanket fix. See [static delivery](static-delivery.md).

MCP is disabled by default. Schema 8 adds registered applications, delegated OAuth credentials, browser approval intents and retained command receipts. Supported recovery disables MCP and fences all old grants before publication; re-enable requires fresh authorization. See [MCP operations](mcp.md) for exact callback registration, client compatibility, ingress rules, bounded retention and rollback.

Schema 9 (`000009_financial_intelligence.sql`) adds only operating-expense categories, obligations, retained payment/reversal events, cancellation receipts and justified financial read indexes. Existing customer ledgers remain unchanged. Supported backup/restore includes all four new tables and verifies net balances, reversals and retained references. Take a fresh schema-9 checkpoint; older snapshots still require a compatible artifact and an independent empty-target recovery plan. No production migration or deployment is performed by the implementation workflow.


Schema 10 (`000010_email_otp.sql`) adds bounded OTP challenges, durable rate events and encrypted temporary mail payloads. Existing accounts, grants, legacy hashes and session families are preserved; password login is retired. Backup bundles retain the shared keyring and validate outbox ciphertext. Empty-target restore invalidates all pending/delivered codes and clears temporary mail material before publication, preserving row counts and security budgets. Take a fresh schema-10 checkpoint. The OTP worker suppresses ambiguous abandoned sends rather than resending them after restart. Normal profile APIs cannot change registered mailboxes; `recover-email` is a deliberate, audited trusted-host procedure, with session/OTP/OAuth revocation. SMTP secrets remain operator-managed, separate from the backed-up application keyring. No code push authorizes production migration/deployment.
