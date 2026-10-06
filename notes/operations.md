# Operations, migration and recovery

The [README](../README.md) contains normal install/update/backup/restore commands. This guide covers protected operations and compatibility. Use the reviewed immutable image on a Linux AMD64 container host with local durable storage, external HTTPS ingress, safe edge throttling/logs and named backup/incident ownership. One serving process owns each data volume. Publication is not deployment authority.

## Configuration and native commands

Compose selects the image/data volume, publishes loopback 8080, and supplies exact `AUTH_PUBLIC_ORIGIN`, explicit secure-cookie policy and optional `REDIS_URL`. Native defaults use absolute `DATABASE_PATH=/var/lib/roisey-else/else.sqlite3`, `FRONTEND_DIRECTORY=/app/frontend` and numeric `HTTP_ADDRESS`; loopback development explicitly uses insecure cookies. Obsolete `DATABASE_URL` is rejected. Optional `INTEGRATION_KEYRING_FILE` must be a protected retained source, and `INTEGRATION_KEYRING_MODE=restored` never makes a previously used key fresh. The standard distribution provisions keys automatically within `.control`.

`/roisey-else help` lists serve, health, migrate, bootstrap, backup, restore, import-postgres, key-inventory and rotate-credentials. JSON operator input is bounded and duplicate/unknown fields reject. Health is a bounded readiness command; Docker probes every 30 seconds after a 20-second grace, with early two-second startup probes and three failures. Unhealthy state alone does not cause Docker restart; process exit activates unless-stopped. Logs contain fixed safe codes, correlation, duration and recognized operation labels, never private input/SQL/provider transport errors.

SQLite migrations run transactionally at startup and verify stored checksums/version. New versions must be additive; an incompatible future schema or edited applied file fails closed. Explicit `make migrate` is a maintenance operation. No automatic down/erase operation exists. Keep disk headroom for WAL/checkpoints, replacement images and verified bundles; alert on readiness/restarts, latency/error rates, job failure/age, disk growth and backup age. Measure actual host capacity and recovery objectives rather than treating a local burst as an SLA.

## Supported backup

`make backup BACKUP_NAME=checkpoint-20261006` invokes SQLite's online Backup API with bounded stepped copying, then verifies integrity, foreign keys, complete relational history/counts, exact payment balances, pricing terms/copies, provider workspace bindings/digests, envelope authentication and key accounting. Snapshot/manifest/retained keys publish as a new immutable private bundle; an existing checkpoint refuses. There is no ordinary live file copy. Both database and keys are private data: encrypt them off-host, restrict custody, retain independently and restore-test.

The bundled database captures a consistent point in time, not every later transaction. Key rotation/source replacement must not race backup custody. Keys remain complete for current ciphertext and retained backups. Redis is disposable and is excluded. A manifest digest detects corruption, not hostile replacement; restore only trusted provenance-verified bundles.

Copy a verified bundle to protected off-host storage with `docker compose cp`. Keep `.control` and all bundle files private; never print or upload them as CI evidence. A cleanly stopped full-volume copy is incident preservation, but resuming rewound encryption still requires the supported fresh-key procedure. Do not point an old database copy directly at serve and assume freshness.

## Supported restore

Stop all serving/provider/encryption writers and preserve the source. Select distinct source/empty target volumes; never start the target before import. Root README commands use `make restore BACKUP_NAME=... SOURCE_VOLUME=... RESTORE_VOLUME=...`, mounting the source read-only and restoring without HTTP/provider startup.

Restore requires absolute protected paths and complete trusted files, holds the exclusive volume lease, writes a durable pending marker before source/database verification and stages/validates the entire SQLite database. The source opens with SQLite READ_ONLY and query-only enforcement, without file creation or write access; verification cannot depend on writable backup storage. It authenticates retained ciphertext and introduces fresh independent active key material/label. Atomic no-replace publication installs keys before database and removes the pending marker only after verification. Failure remains non-serving/incomplete; preserve the failed target and use another empty one rather than deleting evidence or bypassing its marker. Populated targets refuse. A completely full eight-key ring requires reviewed retention/rotation before another key can be added; startup never drops a required decryptor to make recovery pass.

For an off-host bundle, stage the complete verified directory on the host at `/srv/else-recovery/checkpoint`, mode 0700, files 0600 (keyring 0400), owned by UID/GID 65532 so the default runtime can read it. With an explicitly empty replacement volume:

```sh
ELSE_DATA_VOLUME=roisey-else-recovered docker compose run --rm --no-deps -T \
  --volume /srv/else-recovery/checkpoint:/backup-source:ro \
  -e BACKUP_DIRECTORY=/backup-source else restore
ELSE_DATA_VOLUME=roisey-else-recovered make up
```

Review post-checkpoint revocations, disabled users, credential changes, exact financial commands and already-issued external effects before releasing traffic. Restored sessions/grants are checkpoint facts; a revoked session after the checkpoint is not automatically revoked again. Validate permitted/denied operations and exact finance/audit/history counts under the target artifact. Set the accepted target in `.env` only after recovery acceptance; retain source/bundle/decryptors under policy. This procedure does not establish production RPO/RTO or mass-revoke sessions.

Prefer a tested compatible image rollback over restoring data just to undo code. An older binary may not support new schema/provider facts; do not downgrade or remove history to force it. When compatibility is unknown, keep traffic blocked and forward-repair or separately recover/reconcile.

## Existing PostgreSQL installations

The final Rust application cannot open PostgreSQL files. The default volume name deliberately remains `roisey-else_postgres-data`; finding a legacy cluster refuses startup before creating a misleading SQLite installation. Import is an explicit, one-time offline procedure for the exact original **Goose version 28** and 33-table column/type catalog. Other versions need a reviewed conservative adapter, not guessed import. The compressed original schema is retained only as a disposable test oracle.

First record the previous immutable application digest/configuration and selected volume, back up database and retained keys, cleanly stop every old writer, and retain the original volume unchanged for rollback. Perform export on an isolated **clone**, never a live/source cluster. The examples below assume the standard legacy volume and a new clone name; change them to your recorded volume before executing. The temporary official PostgreSQL image is migration infrastructure, not part of the final runtime.

```sh
make down
docker volume create roisey-else-pg-import-clone
docker run --rm --network none --user 0:0 --entrypoint /bin/sh \
  --mount type=volume,src=roisey-else_postgres-data,dst=/source,readonly \
  --mount type=volume,src=roisey-else-pg-import-clone,dst=/clone \
  postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db \
  -c 'cp -a /source/. /clone/'
docker run --detach --name else-pg-import-clone --network none \
  --mount type=volume,src=roisey-else-pg-import-clone,dst=/var/lib/postgresql \
  -e PGDATA=/var/lib/postgresql/18/docker \
  postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db \
  -c listen_addresses= -c unix_socket_directories=/tmp
```

This expects a cleanly stopped PostgreSQL 18 cluster and standard `18/docker` layout. If readiness does not succeed, preserve the clone and investigate; do not delete transient/source files blindly. Verify the isolated final server with `docker exec --user postgres else-pg-import-clone pg_isready --host /tmp --username postgres --dbname else`. No app writers or published ports are allowed. Docker/volume operators are trusted; the exporter additionally checks PID 1/server state and absent published ports, and holds a repeatable-read snapshot with SHARE locks across all source tables.

Escrow the original `.control/integration-keyring.json` privately while the old container is stopped (or use its existing protected key custody). Do not print it. Export requires an absolute 0400/0600 regular single-link key file owned by the invoking operator/root and a private absolute output parent:

```sh
umask 077
mkdir -p /srv/else-import
python3 tools/export-postgres.py --container else-pg-import-clone \
  --database else --key-file /srv/else-import/retained-keyring.json \
  --output /srv/else-import/verified-bundle --confirmed-offline
```

Use a newly named output. Check exit status; a printed export summary is not successful import. The exporter captures all typed source rows, UTC microseconds, binary ciphertext, exact source schema/counts/footer, digest and retained key source without source writes. Import validates strict schema/order/counts/types, source catalog/grants/recovery administrator, finance conservation, immutable pricing/copies, provider data and retained envelopes/accounting. It does not manufacture account profiles, reset credentials/history, or copy old executable SQL. The only deliberately excluded rows are the removed release-checker permission/role links; receipt counts explicitly record them.

The bundle's directory must be 0700, source/manifest 0600 and keyring 0400. Give the protected bundle directory/files ownership UID/GID 65532 for read-only mounting by the default application. Do not relax permissions to world-readable. The parent is trusted operator storage; preserve the separate escrow/source key custody.

```sh
sudo chown -R 65532:65532 /srv/else-import/verified-bundle
make import-postgres IMPORT_BUNDLE=/srv/else-import/verified-bundle \
  IMPORT_VOLUME=roisey-else-sqlite-imported
ELSE_DATA_VOLUME=roisey-else-sqlite-imported make up
```

The importer refuses populated/pending targets and uses the same staged verification/fresh-key/no-replace publication as recovery. It retains a source digest/count receipt and audits the operation. Privately compare the receipt/history and exercise the existing users' sessions, scoped reads/denials, clients, operations, exact finance/copies, audit, websites and stored reports before rollout. Keep old writers offline: import excludes later source changes. After acceptance set the new volume in `.env`. Original PostgreSQL data, old image/config and decryptors remain the rollback path; restarting them after new SQLite writes needs explicit reconciliation, not an assertion of synchronization.

Stop/remove only the explicitly named clone container after export/acceptance; retain/delete its clone volume according to the reviewed retention policy. Never run the compatibility test harness against source data.

## Key operations and custody

Trusted operators may pipe bounded JSON to `make key-inventory` with `actor_id`. The actor must currently hold global clients.view + integrations.manage; UUID attribution is not authentication of the host operator. Inventory exposes only at most eight source positions, active flags and exact stored/eligible/excluded counts. No labels, fingerprints, budgets, accounts or ciphertext are returned, and it creates no audit/reservation.

`make rotate-credentials` accepts actor_id, exact client_id, optional after UUID, limit 1–100 and confirmed:true. It runs one bounded page, separately audited reservations and fresh CAS-fenced rewrap per credential. Rewrap advances revisions but preserves generation. Stop on first failure; output contains only known commits, last confirmed cursor and first pending UUID. Output loss/timeout can follow a committed row: reconcile authoritative history before another explicit page. Do not auto-loop or advance past uncertain work.

Rotation requires a privately provisioned new active key alongside all required old decryptors and restart to load the reviewed source. Excluded archived/disabled/obsolete rows, other clients and backup-only ciphertext can still need old keys. Neither a complete page nor live zero count authorizes retirement. Undeclared clones/rewinds and independent global freshness remain operator responsibilities; never relabel material or reset reservation history.
