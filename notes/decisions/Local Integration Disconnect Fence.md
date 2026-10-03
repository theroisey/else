---
type: decision
status: owner-merged
created: 2026-10-03
tags:
  - integrations
  - authorization
  - database
  - audit
---

# Local Integration Disconnect Fence

Issue #78 records policy before code for parent #24. Credential persistence PR #77 is owner-merged at `03af58daaf4752aaf552224cd609ea509b511d87`; final CI 37112599312 and merged main CI 37112997259 passed all five gates. Both development branches synchronized. No agent merge/deployment is authorized.

PR #79 is now owner-merged at `debac21bd2aa665a380be071cd85fca6819a7c6c`. Final-head CI 37114191531 and merge-head CI 37116529670 passed all five verification gates; both permanent branches synchronized. Issue #80 adds the separate frontend consumer in [[Client Integration Workspace and Manual Revocation]].

The confirmed POST disconnect operation immediately fences local credential use under fresh clients.view, integrations.view and integrations.manage on the real active client. Public view is independently required for the returned metadata and GET-based recovery. Exclusive lifecycle locking precedes ownership/revision checks. Eligible states become revocation_failed; revision and generation increment atomically. Ciphertext/accounting/history remain retained, and already encrypted work cannot persist after the committed fence.

No provider revoker is configured. HTTP 200 confirms local disablement only and explicitly returns unavailable remote revocation plus manual_action_required=true. It neither queues remote work nor reads/decrypts credentials. No disconnected success is invented. Actual revocation/retry/reconnection requires a separately verified provider adapter. The public endpoint is functional local safety behavior; no frontend action is supplied on the backend branch.

Exact 1,024-byte JSON parsing requires unique canonical revision/confirmed fields, rejects aliases/unknowns/numeric revisions/trailing data, and uses the shared cookie/Origin/Content-Type/CSRF contract. Missing/foreign/denied resources share 404; stale/terminal/overflow conflicts preserve state. Archived clients are denied. Current-revision repetition of revocation_failed is freshly authorized but mutation-free. An original lost-response retry conflicts; GET detail supplies reconciliation. No blind retry follows unknown commit.

One typed integration_connection.updated audit records UUIDs, actor/client, exists/revision markers and HTTP source with the local fence. It never claims remote disconnection or stores credentials/accounts/key identities/generation. No-op uses a private rollback sentinel so the existing audited helper still requires an event for every mutation. Audit/commit/cancellation failures return no success without partial fencing. Migration 18 only adds/removes one guarded EXECUTE entrypoint; down/up preserves populated history and regrant is required. Runtime/PUBLIC table/helper boundaries stay unchanged.

PostgreSQL tests cover honest HTTP outcomes, retained material, disabled budget/vault use, exact grants/IDOR/states/overflow, queued revocations, concurrent CAS, post-encryption fencing, cancellation and audit/deferred-commit rollback, safe errors and populated rollback/regrant. Final-head CI accompanies owner review. Startup/restore enforcement, provider policy/OAuth/SSRF/revocation and sync remain incomplete in parent #24.

- [[Encrypted Integration Credential Persistence]]
- [[Durable Integration Encryption Budgets]]
- [[Integration Connection Metadata and Read Boundaries]]
- [[Audit Infrastructure]]
