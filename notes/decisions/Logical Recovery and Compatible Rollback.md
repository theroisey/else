---
type: decision
status: in-review
created: 2026-10-04
tags:
  - readiness
  - recovery
  - database
---

# Logical Recovery and Compatible Rollback

#113 under #32 rehearses actual custom-format pg_dump/pg_restore through the integration runner's own pinned PostgreSQL 18.3 client/server, into a distinct empty database. Protected archive, all app/Goose/sequence fingerprints, post-checkpoint exclusion, truncated archive refusal, retained ciphertext/fresh restore-key checks and restored runtime privileges keep recovery claims concrete. No external/customer database or raw artifact upload.

Actual guarded synthetic writes cover identity/session/grants, clients, task, plan, reminder, pricing version/immutable copied collection/payment and encrypted credential accounting. Current → previously integrated main `9dc9ed9050f6927784dfc3a0bd503a9ffad9aaac` → current compiled APIs run against unchanged schema 21, reading bound facts and appending three exact client revisions/audits. Pin remains intentional: arbitrary older artifacts are not proven compatible. CI fetches reviewed history rather than silently dropping the previous-version proof.

The [operator runbook](../../docs/recovery.md) records trusted archive/role/owner/key mapping, kept ACL revocations, post-checkpoint session revocations and external/financial reconciliation, artifact rollback versus separately approved database recovery, explicit traffic approval and production/PITR/RPO/RTO/provenance limits. One-cluster existing role identities are not fresh-cluster provisioning proof. Startup readiness is connectivity only. No schema down, production operation, key retirement or final #32 closure is authorized.

Final local disposable PostgreSQL race rehearsal passed in 4.338s: 29 app/Goose table fingerprints plus sequence state, actual truncated archive refusal, restore-key/grant checks and current/prior/current bound reads and exactly three audited revisions. All Go race tests, ordinary/integration vet, readonly static build, shell syntax and actionlint (local ShellCheck unavailable) passed. All six exact-head CI gates and owner review remain required before integration.

- [[Remaining Roadmap]]
- [[Integration Key Startup and Restore Enforcement]]
