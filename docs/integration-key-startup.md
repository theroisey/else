# Integration key startup and declared restores

Current standard distribution: one `else` container includes PostgreSQL, Go-served React/API, and the supervised analytics worker. Startup automatically applies migrations/grants and provisions a durable protected integration keyring. API/worker run as UID 65532; restricted root supervision and separate PostgreSQL/migrator identities handle initialization. See [Docker operations](docker.md) for current installation commands. Standalone source/operator examples and older CI evidence below retain their original scope.

[Issue #82](https://github.com/theroisey/else/issues/82) adds protected key-file loading and a read-only database preflight before the API listens. It supplies no credential acceptance, provider connection, OAuth, synchronization or key-retirement operation. #84 separately adds private [bounded eligible rewrap batches](integration-rotation.md); #88 adds a [trusted one-page operator command](integration-rotation-command.md) using the same loader/preflight. API startup still exposes no rotation route. Parent #24 remains incomplete.

## Configuration

| Variable | Behavior |
| --- | --- |
| `INTEGRATION_KEYRING_FILE` | Optional absolute, cleaned file path. When absent, key-dependent runtime is disabled; metadata reads and local disconnect remain available. Explicit empty/invalid/unreadable configuration fails startup. |
| `INTEGRATION_KEYRING_MODE` | `normal` when omitted; explicit values are exactly `normal` or `restored`. Setting a mode without a file fails startup. |

The document uses the [existing strict key-ring format](integrations.md#key-provisioning-parsing-and-rotation): at most 8,192 bytes and eight distinct keys, one active label, independently random 32-byte AES keys, canonical base64, and no duplicate/unknown fields. Key material belongs in external secret provisioning, never environment values, command arguments, Git, database rows, logs or frontend assets. Environment configuration carries only the path and mode.

Configured loading is supported on Linux. The final file must be regular, have exactly one hard link, belong to the process UID or root, permit owner reads, and have mode `0400` or `0600`. Executable, set-ID, group/world permissions, empty/oversized files, final-component symlinks and special files fail. The process must actually be able to read a root-owned file; root ownership does not bypass OS access checks. Unsupported platforms refuse configured loading.

The loader opens one no-follow/nonblocking descriptor, validates its identity and metadata before and after bounded parsing, then closes it. This avoids waiting on FIFOs and rejects observed file changes. Parent mount directories must be trusted: this policy rejects the final symlink, rather than resolving every parent without symlinks. Provision a stable local secret mount; cancellation is checked around file access, but regular-file filesystem I/O has no independent wall-clock timeout. No hot reload exists; changing the file requires an orderly process restart.

The production backend runs as UID/GID `65532:65532`. Provision its mounted file for that owner with mode `0400`, and mount it read-only. Ensure the mounted directory allows traversal by that UID. Secret mounts exposing group/world readability or a symlink as the final configured file are incompatible: provision a protected regular file through the deployment's trusted secret mechanism. The standard container creates a root-private durable master and a UID-65532-owned mode-0400 runtime copy; custom file mounts still obey these rules.

## Read-only database preflight

Apply migration 19 and its reviewed runtime EXECUTE grant before enabling key configuration. In a read-only transaction with a ten-second database deadline, the fixed-search-path/UTC SECURITY DEFINER function takes the shared integration lifecycle lock and returns only a boolean. Runtime receives no registry/credential table privileges; PUBLIC receives no execution privilege. The private Go boundary copies sorted labels and fingerprints without extracting raw key material.

Startup fails when any configured identity conflicts with permanent budget history: an existing label cannot acquire different material and existing material cannot acquire another label. Every current credential row must have its exact retained decryption key in the ring, including locally disabled connections and obsolete generations. An already exhausted active key fails; a fresh active identity may pass without registering it. Backup-only keys cannot be inferred from current database rows and remain the operator's retention responsibility.

Preflight does not register keys, reserve encryption capacity, decrypt credentials, modify metadata or emit audits. Migration 19 down removes only this capability under the exclusive lifecycle lock, preserving populated credentials/budgets/audits; up requires regrant. Existing schema-history rollback guards still apply. Every future credential producer must consume the validated ring through the audited budget and fenced vault path, with fresh authorization for each operation. Passing startup is neither a reservation nor permission to write.

Configuration, file/parser and preflight failures use the single fixed `integration_key_startup_failed` log event and nonzero exit before listening. Paths, labels, fingerprints, key bytes and underlying parser/I/O/SQL diagnostics are omitted. Startup checks are not ongoing provider health checks; `/ready` retains its PostgreSQL connectivity contract.

## Known restore procedure and limits

Reservation history can rewind with a restored database. **The code cannot automatically detect an undeclared restore, or material used after the snapshot that is absent from its restored registry.** `restored` is an explicit operator declaration, not proof that a key has never been used anywhere. Operators must also maintain external provisioning history and unique material per environment/database.

For every restore, clone or recovery capable of rewinding counters:

1. Stop and drain all encryption writers and replicas before recovery. Ensure no old-key writer can resume against the recovered database.
2. Independently provision never-used random active material with a never-used label outside the database, retaining all keys needed by current ciphertext and retained backups. Do not reuse restored reservation counts as available old-key capacity.
3. Apply migrations and narrow runtime grants. Mount the protected ring and start with `INTEGRATION_KEYRING_MODE=restored`. This rejects an active label/material identity already present in the restored registry while still requiring old decryption keys.
4. Once a separately implemented, authorized producer commits its first audited reservation for the new key, switch to `normal` before restarting replicas. `restored` deliberately refuses a now-registered active key on a later startup. This slice exposes no producer or reservation CLI; do not manually seed registry rows as a substitute for the audited write path.

Normal mode permits an existing nonexhausted active identity and supports ordinary restarts against one authoritative primary database. It cannot establish restore safety. Fresh-key switching also requires externally excluding stale writers; startup does not retire old active keys globally. Keep old keys for decryption only after recovery, rotate through the budgeted vault, and retain them until separately verified live-row and backup expiry/restore proof allows retirement. Key loss makes ciphertext unrecoverable; re-encryption does not revoke compromised provider credentials.

## Verification

Unit/race tests cover configuration redaction, protected file modes/ownership, symlink/hard-link/FIFO/special-file refusal, parser limits, cancellation and copied identity buffers. Real PostgreSQL tests cover exact identity/retained-key matching, obsolete generations, exhausted keys, declared freshness, no mutation/audit, private grants, queued lock visibility, cancellation/reuse and populated down/up/regrant. The startup slice verified nineteen migration versions; current full roundtrip includes twenty with #84. Container CI checks actual UID 65532 API startup with protected files, fixed private failures, rejection of a registered restored active key and acceptance of fresh active material without registry writes. No tests claim automatic restore detection or provider readiness.
