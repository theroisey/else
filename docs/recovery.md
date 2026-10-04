# Database recovery and compatible API rollback

[#113](https://github.com/theroisey/else/issues/113) supplies a rehearsed logical recovery procedure under [#32](https://github.com/theroisey/else/issues/32). Execute production operations only with the environment owner, approved recovery checkpoint, reviewed role/image/schema mapping and explicit rollout authority. The repository integration runner always uses its own disposable PostgreSQL server; never supply a customer database to it.

## What the rehearsal establishes

The integration suite uses PostgreSQL 18.3 and its matching `pg_dump`/`pg_restore` binaries from the pinned server container. It seeds real sessions/grants and guarded task, plan, reminder, pricing, copied collection/payment and budgeted encrypted credential writes alongside two synthetic clients. It stops the compiled API, captures a custom archive in a mode-0600 temporary file, restores into a different empty database and privately compares every `app` table, Goose history and sequence state. A later source write is excluded from the recovered checkpoint. A truncated archive must fail without leaving application objects in another empty target.

The recovered runtime cannot read ciphertext, delete audit history, rewrite migration history or create application tables. PUBLIC schema access stays revoked. Retained keys authenticate actual restored ciphertext; declared restore rejects a previously registered active identity or a missing retained key and accepts a fresh active identity with retained material. The checks are read-only and must preserve the recovered fingerprints.

Real compiled current → pinned previous → current APIs read the recovered client/tasks/reminders/collections/pricing/integration metadata and perform three client revisions with exactly three atomic audits. The pinned previous source is integrated main `9dc9ed9050f6927784dfc3a0bd503a9ffad9aaac`; both sources use schema version 21. This is compatibility proof for this pair of source artifacts against this schema. It does not prove arbitrary previous versions, production images, a frontend rollback, restored roles in a fresh cluster, gateway/secret mounts, provider synchronization, managed PITR, retention durability or production RPO/RTO.

## Prepare a recoverable checkpoint

Assign an incident commander, database/recovery operator, secret custodian and rollout approver; record approved checkpoint, target database, matching PostgreSQL tools, migration version, verified API/frontend image digests and source revisions, role ownership/grants, encryption-key inventory and validation/abort criteria in the restricted operating record. Record elapsed times and chosen RPO/RTO objectives rather than inferring them from this small synthetic rehearsal. Keep customer identifiers, database URLs, passwords, raw archives and key material out of application logs, issues and CI artifacts.

For a planned checkpoint, drain all API replicas and every background/provider/encryption writer. Quiesce independent writers too; stopping one HTTP process does not establish that a database is quiet. PostgreSQL logical dumps use a consistent snapshot, but post-checkpoint transactions are absent from that recovery point. A running-system dump and a provider's PITR capability need separately reviewed consistency/reconciliation procedures. Background job leases/external side effects are not supplied by this test.

Use an approved backup identity that can read all required objects and protected rows, not the API runtime identity. The archive contains private domain facts, password/session hashes and encrypted credentials even though raw provider credentials and encryption keys are absent. Store it encrypted in the approved durable backup system with separate access/retention, verification and restore drills. A checksum detects transport corruption; it does not encrypt or authenticate an archive. Restore only a trusted, provenance-verified archive: PostgreSQL restore executes its schema/function definitions.

The following operator example assumes a protected directory has already been provisioned in `RECOVERY_DIRECTORY` and a TLS-verified backup URL has been supplied privately as `BACKUP_DATABASE_URL`. Neither contains a shell fragment. The command passes credentials through the environment rather than arguments and never echoes them. Use controlled libpq configuration with no unexpected service/password files or options; follow the [database TLS/role guide](database.md).

```sh
set +x
set -eu
umask 077
: "${RECOVERY_DIRECTORY:?Provision a protected recovery directory}"
: "${BACKUP_DATABASE_URL:?Load the approved backup URL privately}"
task_archive="$RECOVERY_DIRECTORY/checkpoint.dump"
# Choose a new checkpoint filename; never overwrite an accepted archive.
[ ! -e "$task_archive" ] && [ ! -e "$task_archive.partial" ]
PGDATABASE="$BACKUP_DATABASE_URL" pg_dump --no-password --format=custom \
  --file="$task_archive.partial"
pg_restore --list "$task_archive.partial" > "$RECOVERY_DIRECTORY/checkpoint.contents"
mv "$task_archive.partial" "$task_archive"
sha256sum "$task_archive" > "$RECOVERY_DIRECTORY/checkpoint.sha256"
```

Keep failed partial files quarantined as incomplete; never promote or restore them as accepted backups. Archive inspection/checksum alone does not prove restoration. Do not dump global role passwords with `pg_dumpall` as a substitute for approved identity provisioning. Maintain source/target owner and runtime role mappings separately; a database archive does not recreate cluster-global roles or external key material.

## Restore into an isolated new database

1. Stop/drain all writers and prevent stale replicas/old-key producers from reconnecting. Preserve the affected database and immutable incident evidence. Create a separately named empty recovery database; never use `--clean`, restore over the live database or cascade away retained history as a shortcut. Provision the approved nonsuperuser migration owner and independent runtime role, PUBLIC restrictions and secret sources first.
2. Verify archive provenance/checksum and matching tool/server versions. Verify every source ACL recipient exists in the target and the SECURITY DEFINER ownership mapping is reviewed. The example below changes object ownership to the separately provisioned `else_migrator` while retaining archive ACL statements; do not use `--no-acl` because omitting private function revocations can expose guarded functions through PostgreSQL defaults. The disposable test preserves existing matching roles in one cluster; fresh-cluster ownership mapping remains an operator validation step.
3. With `RESTORE_DATABASE_URL` privately provisioned for an identity authorized to SET ROLE to the approved migration owner:

```sh
set +x
set -eu
: "${RESTORE_DATABASE_URL:?Load the isolated restore URL privately}"
PGDATABASE="$RESTORE_DATABASE_URL" pg_restore --no-password \
  --exit-on-error --single-transaction --no-owner --role=else_migrator \
  "$task_archive"
```

4. On any error keep the target isolated and mark recovery incomplete. Verify object owners, exact PUBLIC/runtime grants, all domain/history counts or private fingerprints, sequences and applied Goose versions. Compare the accepted checkpoint, not later live source state. Run reviewed migration `status`; apply only the target artifact's approved pending `up` steps and [narrow runtime grants](../backend/scripts/grant-runtime.sql). Never `down` populated history to make an older binary start. `/ready` proves PostgreSQL connectivity, not schema compatibility or correct privileges.
5. Follow the [declared restore key procedure](integration-key-startup.md#known-restore-procedure-and-limits): provision never-used active material/label externally, retain all keys required by live ciphertext and retained backups, exclude old writers and mount a protected regular key file. Start declared `restored` mode; switch to `normal` only after the new key's first confirmed audited reservation and before restarting additional replicas. Do not seed accounting manually or reuse rewound old-key capacity. Missing retained keys make ciphertext unrecoverable; declared mode cannot detect an undeclared restore or independently prove material freshness. The recovery test authenticates retained synthetic ciphertext and tests preflight; it does not activate provider/encryption writers.
6. Treat restored sessions/grants as checkpoint facts: the test proves a retained unexpired session remains valid, which is useful evidence and a recovery risk if a later revocation is absent. Review all post-checkpoint revocations, disabled users, credential changes, financial commands and external side effects before opening traffic. Apply reviewed revocation/reconciliation procedures under incident authority; the application does not automatically replay missing history or mass-revoke sessions on restore. Never blindly retry financial/provider writes after uncertain outcomes.
7. Start the approved immutable artifacts against the isolated target. Check startup/private logs, liveness/readiness, real authorized and denied routes, client boundaries, financial/pricing snapshots and a disposable validated write/audit. Validate same-origin cookies, TLS/edge security, protected secret mounts, replica/connection budgets, log sink and background exclusion separately. Only the rollout approver can release traffic after recorded acceptance. Keep the original checkpoint/source and required keys under retention policy.

## Roll back application artifacts without rewriting history

Drain affected replicas and pause background/encryption writers. Identify the last reviewed immutable API and frontend digests with source/provenance evidence. Confirm compatibility with the currently applied schema, grants, config and retained secret material using the isolated rehearsal. Switching the API artifact does not imply that the frontend or provider/background contract is compatible.

Prefer artifact rollback against the existing database when the reviewed pair is compatible; do not restore the database merely to undo a software release. Restart the previous artifacts, validate actual reads, an authorized mutation and atomic audit plus denial cases, then request the defined traffic approval. If compatibility is unknown, keep traffic blocked and choose an approved forward repair or separately approved recovery/reconciliation plan. Schema `down`, deleted audits and restored counters are not routine application rollback operations.

For this tested pair, schema remains version 21 throughout current/prior/current restarts; original sessions/grants and private storage survive, revisions advance once per accepted mutation and audit history is appended. The prior binary is built from pinned reviewed Git source with source metadata; this is not a claim that a deployed image's provenance or rollback has been verified.

## Repeat the local/CI rehearsal

From the repository root with reviewed Git history, Go, Docker and openssl:

```sh
sh backend/scripts/test-integration.sh
```

The runner creates its own pinned server, random password, loopback port and private temporary credentials, exports its container identity for matching dump/restore clients and removes owned resources on exit. The PostgreSQL CI checkout fetches history for the pinned prior source. The tagged logical-recovery test fails when its matching disposable container/history is missing; it never silently skips. An external `TEST_DATABASE_URL` alone no longer satisfies the complete suite. Run unit/vet/build and all six final-head CI gates as well. Private archives are temporary test files, not retained CI artifacts. Local results, exact-head CI and limits belong in #113/its PR and #32; final readiness and production approval remain separate.
