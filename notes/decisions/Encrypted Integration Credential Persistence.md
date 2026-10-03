---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - integrations
  - encryption
  - database
  - audit
---

# Encrypted Integration Credential Persistence

Issue #76 records policy before code for parent #24. Budget PR #75 is owner-merged at `f97636efbc0fbedf552538b3c4634fb6bc3e9aaa`; final CI 37110370452 and merged main CI 37111204913 passed, and both development branches synchronized. No agent merge/deployment is authorized.

Migration 17 keeps one bounded encrypted access-token envelope per permanently owned connection, with a budget-key FK, positive row revision/generation and UTC timestamps. Only guarded EXECUTE grants reach the runtime; private tables/helpers and PUBLIC execution are denied. Framing must match a used budget label; authentication remains the reviewed crypto boundary. Owner DML cannot rewrite identity, skip/decrease revisions, reduce generation or delete/truncate credentials. Replacements overwrite the current live envelope atomically; historical envelopes may still exist in backups.

The private vault supplies Inspect checkpoints and budgeted Replace/Rewrap, with current independent clients.view plus integrations.manage on the real active client and eligible connection. Shared lifecycle locking protects private reads. After committed reservation/encryption, an exclusive-lock storage transaction freshly checks authority and compares the connection revision, generation and credential revision. Initial/replacement storage advances token generation; single-row key rewrap preserves generation and advances both revisions. Obsolete-generation ciphertext cannot be rotated back into use. Concurrent rotation/replacement cannot overwrite a winning token. Reconstructed services resume from the stored checkpoint. No automatic mutation retry follows an uncertain commit.

integration_credential.created/updated and integration_connection.updated commit with storage/metadata, using only UUIDs, actor/client, exists/revision markers and CLI source. Capacity reservation remains a separate event and is never refunded after storage failure. Existing audit readers remain compatible. Stored tokens do not change connection state or prove provider success. No HTTP credential route, plaintext read operation, startup keys, real credential acceptance or provider traffic is supplied.

Empty rollback/regrant preserves connection/budget history; any credential row or credential audit refuses down. Old decryption keys must survive live-row and backup retention until separately verified restore/retirement proof allows removal. After restore/clone/recovery that can rewind reservation counts, provision fresh independent active material with a never-used label before encryption; old keys become decryption-only. This library cannot detect rewind or supply that operator gate. Startup/restore tooling, bulk rotation, key retirement, provider policy/OAuth/revocation and synchronization remain future work; parent #24 stays incomplete.

Tests cover authenticated persisted envelopes, restart/retained-key rotation, exact fences, concurrent winners, post-encryption revocation/disablement/archive/disconnect/cancel/generation changes, audit/deferred-commit rollback without refunds, tampering, single-connection pools, safe projections, permissions, private grants and retained rollback. Final-head CI evidence accompanies the PR/Issue before owner review.

- [[Durable Integration Encryption Budgets]]
- [[Integration Credential Encryption and Rotation]]
- [[Integration Connection Metadata and Read Boundaries]]
- [[Audit Infrastructure]]
