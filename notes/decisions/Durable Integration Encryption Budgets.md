---
type: decision
status: owner-merged
created: 2026-10-03
tags:
  - integrations
  - encryption
  - database
  - audit
---

# Durable Integration Encryption Budgets

Issue #74 records policy before code and supplies the accounting prerequisite for later credential persistence in parent #24. Metadata PR #73 is owner-merged at `44c59b7f50e01f33a6e0b80a836666dd76ff91bd`; main run 37108435621 passed and both branches synchronized. No agent merge/deployment is authorized.

Migration 16 stores private immutable key labels, material SHA-256 fingerprints and monotonic counts; cap each independently random key at 2^24 committed reservations in one authoritative database. A fingerprint prevents relabeling a used key to reset its quota; a label cannot acquire different material. Counter increments are irreversible and retired identities remain retained. Runtime has two guarded EXECUTE grants only. Any budget or matching reservation audit history refuses down; empty rollback/regrant is verified.

The budgeted backend Seal/Rewrap wrapper commits accounting plus a typed integration_encryption.created event before crypto. Event UUID/actor/client/exists markers/CLI source record allocation without labels, fingerprints, counts, plaintext or envelope bytes. The event is not provider/crypto/persistence success. Then a separate transaction rechecks current clients.view plus integrations.manage on permanent metadata and holds the shared lifecycle lock through crypto. Only active clients with pending/connected/reauthorization_required connections can encrypt. Revocation/disconnect in the gap returns no ciphertext without refund. Result revision/generation are backend context for a later freshly authorized storage CAS. Future lifecycle writers require the exclusive lock. No permission seed, connection write, credential persistence, HTTP API, startup key loading or provider call is added.

Raw crypto primitives remain callable for internals/synthetic tests; every future application encryption/rewrap must use the budget wrapper. Replica services must use one primary database and independently provisioned keys per environment. Snapshot restore can rewind counters: the code cannot detect that. After every restore/clone/recovery capable of rewind, use fresh independent material and a never-used active label before sealing; retained keys are decryption-only. Do not resume old-key encryption from a backup count. Follow-up #82 supplies [[Protected Integration Key Startup and Declared Restores]], an explicitly declared gate with no automatic restore detection. External writer exclusion and never-used material provisioning remain mandatory. Follow-up #84 adds [[Bounded Integration Credential Rewrap Batches]], never refunding reservations after later row failure. Counter history does not authorize key retirement; old-key backups and live rows still require retention/restore proof.

Tests cover concurrent exhaustion without overshoot, identity aliases, restart/rotation, audit/deferred-commit failure, wrong binding, postcommit cancellation/disconnect/revocation, lifecycle locking, exact fences, private privileges and rollback. PR #75 is owner-merged at `f97636efbc0fbedf552538b3c4634fb6bc3e9aaa`; final-head CI 37110370452 and merged main CI 37111204913 passed all five validation jobs. Both development branches synchronized. Issue #76 builds private credential persistence on the reserved result. Parent #24 remains incomplete.

- [[Encrypted Integration Credential Persistence]]
- [[Integration Credential Encryption and Rotation]]
- [[Integration Connection Metadata and Read Boundaries]]
- [[Audit Infrastructure]]
