# Bounded integration credential rewrap batches

[Owner-merged Issue #84](https://github.com/theroisey/else/issues/84) adds `internal/integrations/rotation`, a private backend consumer of the existing audited budget and fenced vault. The separate [trusted operator command](integration-rotation-command.md) in #88 supplies protected loading and explicit one-page invocation. No HTTP route, scheduler, real credential acceptance or provider call is added. Parent #24 remains incomplete.

## Source and authorization prerequisites

The trusted backend owner supplies the immutable ring after [protected loading and any declared-restore startup checks](integration-key-startup.md). Old-key writers must be stopped externally after recovery or active-key switching. Every page repeats the normal read-only preflight, requiring exact identity matching, retained keys for every current credential row and nonexhausted active material. Preflight failure returns fixed `ErrUnavailable` before selection or reservation; it does not reveal the cause. Declared restore enforcement and external never-used material provisioning remain the source owner's responsibility.

`Run(ctx, actor, client, after, limit)` requires a trusted user actor, real client, canonical lowercase nonzero UUIDs, correlation context and an explicit limit from 1 to 100. `after` is either empty or a canonical nonzero connection UUID. The candidate reader requires independent current `clients.view` plus `integrations.manage` on that active client, even for an empty page. Metadata/view/analytics permissions do not substitute. There is no cross-client enumeration; knowing a UUID supplies no authority. Subsequent vault stages freshly check management, ownership, state and revisions before reserving, encrypting and committing.

## Candidate selection and work bounds

Migration 20 adds one VOLATILE SECURITY DEFINER candidate function with fixed `pg_catalog` search path and UTC. It takes the shared lifecycle lock before current authorization/client reads and returns only connection UUID, connection revision/generation and credential revision. Runtime gets EXECUTE only; PUBLIC and registry/credential tables remain private. No ciphertext, account identifiers, key labels/fingerprints or counters leave this projection. Target identity conflicts are refused.

Candidates are selected-catalog `pending`, `connected` or `reauthorization_required` connections with a current credential generation matching the connection and material different from the active key. Already-active rows, absent credentials, obsolete generations and local-disabled/terminal connections are excluded. Archived clients are denied. Excluded credentials remain retained and still require decryption keys at preflight.

Selection is read-only, in ascending connection UUID order after the caller's cursor, with at most `limit + 1` rows for lookahead. The reader releases its transaction/connection before sequential vault work, including with a one-connection pool. The page has a thirty-second work deadline honoring a shorter parent cancellation; transaction cleanup retains the existing separate five-second bounds. Every selected row uses its exact captured checkpoint through `vault.Rewrap`; concurrent replacement/generation changes cause a conflict rather than silently refreshing the plan or overwriting a winning token. Generation and provider state stay unchanged; credential/connection revisions advance together.

Each row commits an audited encryption reservation before crypto, then commits its existing safe credential and connection audits with storage. There is no batch-wide transaction or new event/schema. No reservation is refunded, including failed authentication, quota races, stale CAS, cancellation or uncertain outcomes. Selection itself writes no audit or capacity.

## Partial progress and explicit recovery

| Result field | Meaning |
| --- | --- |
| `Rewrapped` | Number of row commits positively confirmed during this request. |
| `ResumeAfter` | Last positively confirmed connection UUID, or the supplied cursor when none committed. |
| `Pending` | First failed/unconfirmed row UUID, when execution reached a candidate. Never automatically advance past it. |
| `PageComplete` | Every selected row in this bounded page finished without error/cancellation. False on any failure. |
| `More` | A further candidate was observed in the planning lookahead; concurrency can change that observation. |

The service stops on the first failure and makes no automatic retry. Fixed errors distinguish invalid requests, denied/missing clients, revision conflicts, mid-page budget exhaustion and unavailable outcomes without raw SQL/crypto/key details. Earlier row commits remain committed. A reservation or an error does not prove a credential write succeeded.

Inspect the returned error and partial result together. Resolve/reconcile `Pending` through freshly authorized trusted reads before deciding a new explicit request. A missing candidate is not proof of successful rotation: disconnect, replacement, archive or other concurrent changes may explain it. Persist any verified resume cursor only with its actor/client/active-key context in a separately implemented trusted scheduler; this slice persists no job. An explicit restarted scan from an empty cursor skips rows currently on the active material, avoiding repeat reservations for confirmed work. A failed or uncertain attempt may still have consumed capacity.

The UUID cursor is caller-owned and confers no permission, snapshot consistency or completion certificate. Reset it when switching client/active material, or when concurrent changes may create candidates behind it. New rows can appear after a page snapshot; a lookahead can become stale. Quiesce writers and perform a fresh scan when stronger operating proof is required. The library does not enforce a global active-key epoch or exclude stale writers.

## Retention and rollout limits

Only a successful `PageComplete && !More` result reaches the observed end of this **eligible** scan. That does not establish that disabled/obsolete/other-client rows are rotated, all concurrent writes are drained, backups are readable without retained keys, or any key can be retired. Keep required keys for live ciphertext and all retained backups until separately reviewed inventory, expiry and restore proof permits removal. Normal preflight cannot detect undeclared restore. Rewrap does not revoke compromised provider credentials or prove remote health.

Apply migration 20 and its reviewed grant before using the library. Down removes only the candidate entrypoint under the exclusive lifecycle lock, preserving populated credentials, accounting and audits. With migration 22 applied, its guarded down must first accept the retained history (it refuses selected-provider or unresolved integration facts). With migration 21 applied, remove its separate inventory entrypoint; reaching version 19 removes the migration 20 candidate reader. Up requires regrant. Existing history-preserving lower migration guards still apply. No new permission seed, frontend contract or default production wiring is introduced.

Issue #90 adds separate [live retention counts](integration-key-inventory.md) across all clients under global authority. Counts include excluded rows but never authorize retirement or replace backup/restore proof.

## Verification

Unit/race tests verify input/error boundaries, unchanged selected checkpoints, lookahead bounds, no retries and honest known progress/cancellation. Real PostgreSQL verifies candidate order/paging and service restart, current exact grants/empty IDOR denial, retained excluded rows, material aliases, private privileges, tampering, quota exhaustion after a confirmed commit, deferred storage-commit failure and explicit resume, one-connection pools, queued revocation, post-encryption permission/state/generation/audit/cancellation fences, concurrent CAS and populated rollback/regrant. Full empty migration roundtrip includes twenty versions. These proofs do not authorize a provider connection, deployment or key retirement.
