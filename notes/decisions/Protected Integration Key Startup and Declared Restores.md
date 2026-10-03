---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - backend
  - security
  - database
---

# Protected Integration Key Startup and Declared Restores

Issue #82 follows owner-merged interface #80 / PR #81 at `306204bac90a1926e7487854377728ce095d5ee7`. Final-head CI 37118573736 and main CI 37124787974 passed all five gates; both permanent branches synchronized before backend work. The issue records file, restore, privilege and retention policy before implementation. Parent #24 stays open.

Optional INTEGRATION_KEYRING_FILE enables the existing bounded immutable ring at API startup. Absent configuration leaves key-dependent runtime disabled. Explicit invalid configuration fails before listening with only integration_key_startup_failed. Linux uses a nonblocking/no-follow descriptor, process/root ownership, owner-readable regular mode 0400/0600, single link, bounded size and before/after identity/metadata checks. Final symlinks and special files fail; trusted mount parents remain an operator requirement. File I/O has no separate wall-clock timeout. No hot reload, default mount or production key is supplied.

Migration 19 adds one boolean SECURITY DEFINER capability with fixed pg_catalog search path/UTC and the shared lifecycle lock. The Go preflight runs read-only with a ten-second database bound, checks all configured identities against immutable budget history, requires exact retained keys for every current credential row including disabled/obsolete generations, and rejects an exhausted active key. It registers/reserves/decrypts nothing and emits no audit. Runtime EXECUTE is the only new grant; PUBLIC/table/helper boundaries remain private. Populated down/up preserves history and requires regrant.

Explicit mode restored additionally refuses an active identity already in the restored registry. It cannot detect an undeclared restore or post-snapshot material absent from restored history. Stop all writers before recovery, provision independently random never-used active material/label externally, retain decryption keys, declare restored, and return to normal after the future producer's first audited new-key reservation before restarting replicas. Old-key writers must remain excluded externally. No credential producer/CLI, provider readiness, automatic recovery detection, bulk rotation or key retirement is implemented here. Current DB coverage cannot authorize removal of backup-only keys.

Focused and full backend/real PostgreSQL verification and final-head five-gate CI accompany owner review. Tests prove protected loading, private failures, identity/retention/capacity/declared-freshness checks, lock visibility/cancellation, no mutation, narrow privileges and retained populated rollback. Container proof runs the actual non-root API with transient public synthetic key fixtures. See [operating guide](../../docs/integration-key-startup.md). No agent merge or deployment is authorized.

- [[Client Integration Workspace and Manual Revocation]]
- [[Encrypted Integration Credential Persistence]]
- [[Durable Integration Encryption Budgets]]
