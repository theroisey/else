# Integration security boundaries

Parent [Issue #24](https://github.com/theroisey/else/issues/24) is deliberately split. Owner-merged #68 / PR #69 supplies credential encryption and in-memory key rotation; #70 / PR #71 supplies frontend permission compatibility. [Issue #72](https://github.com/theroisey/else/issues/72) adds durable secret-free connection metadata reads. Meta Ads is the planned first provider, recorded in [#25 before code](https://github.com/theroisey/else/issues/25#issuecomment-5966713552). No connection, credential, metric or synchronization success is seeded or created by this API.

## Implemented credential foundation

`backend/internal/integrations/credentials` uses standard-library AES-256-GCM with `cipher.NewGCMWithRandomNonce`. `New` accepts one active key label and up to eight independently provisioned 32-byte keys. Labels and key material must be distinct; unknown active keys, all-zero material and invalid lengths fail. The immutable ring supports concurrent callers and does not retain their key buffers. Encryption uses only the active key; decryption permits explicitly retained keys.

`Seal` accepts 1–16,384 plaintext bytes plus a binding of canonical lowercase nonzero client/connection UUIDs and safe provider/purpose identifiers. Labels/identifiers contain 1–64 lowercase ASCII letters, digits, underscores or hyphens, beginning with a letter or digit. Bindings must come from trusted immutable connection metadata after authorization. Provider and purpose are adapter-owned identifiers, never arbitrary URLs, account labels or credentials. Reassigning a connection to another client/provider is forbidden; a different binding requires an explicitly authorized new connection.

The version 1 binary envelope contains:

| Bytes | Meaning |
| --- | --- |
| First byte | Version `1` |
| Second byte | Key-label byte length `1`–`64` |
| Following label bytes | Key identifier, not key material |
| Next 12 bytes | Cryptographically random GCM nonce generated internally |
| Remaining bytes | Ciphertext and 16-byte authentication tag |

GCM authenticates the exact header and the domain prefix `roisey-else/integration-credential` followed by a zero byte, then the header, then each binding field preceded by a zero byte in client/connection/provider/purpose order. Strict ASCII fields make this encoding unambiguous. The maximum envelope is 16,478 bytes. Changing version, key label, nonce, ciphertext, tag or any binding field prevents successful decryption.

`ParseEnvelope` bounds and copies storage bytes; it does **not** authenticate them. `Open` authenticates before returning a new plaintext buffer. Malformed envelopes, missing/wrong keys, tampering and wrong bindings all return the same fixed `ErrOpen`, with no plaintext. `Rewrap` authenticates the existing envelope, encrypts with the active key and a fresh nonce, then clears its temporary plaintext. It performs no persistence, checkpoint or audit write.

`Envelope.Binary()` explicitly returns a copy for storage. Ring/envelope formatting and structured logging redact values; JSON serialization fails with safe fixed errors. Sensitive fields sit behind private pointers because unsupported formatting verbs can bypass an outer formatter. These safeguards do not protect deliberately extracted byte buffers, reflection/debuggers, memory dumps or plaintext logged by a caller. Never pass keys, plaintext, binary envelopes or provider responses to logs/audits/API responses.

## Key provisioning, parsing and rotation

`ReadKeyring(io.Reader)` accepts a caller-owned protected secret source, limited to 8,192 bytes. It rejects unknown/case-aliased/duplicate fields, duplicate key labels/material, trailing JSON, invalid key sizes and noncanonical padded standard base64. Parser and reader errors discard raw details. The document has this shape; placeholders are intentionally not valid credentials:

```json
{
  "active_key_id": "production-v2",
  "keys": [
    { "id": "production-v1", "key_base64": "<base64 of 32 independently random bytes>" },
    { "id": "production-v2", "key_base64": "<base64 of 32 new independently random bytes>" }
  ]
}
```

Keys belong in a deployment secret manager or protected read-only mounted file, separately from ciphertext/database backups and unique per environment. Never put them in Git, browser bundles, database columns, command-line arguments or log output. This slice reads no file/environment automatically and changes no API startup configuration. The future persistence/adapter owner must load the ring only when integrations are configured, fail closed when required keys are unavailable, and validate mount access/permissions without logging contents or paths.

Before enabling durable encryption, the operator must track a key's total encryption count across replicas/restarts, including rewraps, and rotate before the standard random-nonce GCM limit of 2^32 messages per key. A conservative operational budget must be agreed and enforced by the persistence owner; the in-memory primitive has no global counter. Randomness failure is fatal in the standard library; no fixed nonce or plaintext fallback exists.

Rotation requires the later storage owner to provision a new key, retain old keys for reads, switch the active label, authenticate/re-encrypt rows in bounded batches and atomically replace ciphertext using row revision/generation checks. Count each re-encryption toward the new key's budget. Resume from verified checkpoints; do not retire an old key until all live records and every retained backup needing it have expired or been re-encrypted/restored and verified. Restore tests must include both old and new envelopes. Key loss makes affected ciphertext unrecoverable. Re-encryption does not undo compromise of old keys/backups; credential compromise requires provider revocation/reconnection and incident handling.

Callers should clear their input keys and returned plaintext promptly. The reader clears raw document/decoded key buffers, and rewrap clears its plaintext. Go's JSON strings, cipher key schedules and runtime copies cannot be guaranteed erased; this is encryption at rest, not process-memory isolation. Tests use conspicuously synthetic fixed material, never production credentials.

## Frontend permission compatibility

The strict administration catalog/role parsers reject unknown keys. Owner-merged #70 adds client-defined `integrations.view` to the frontend scope map before migration 15 introduces it. Identity parsing preserves structurally valid future keys, while capability checks deny unknown keys. This follows the earlier finance permission-consumer ordering.

View does not imply integrations.manage, analytics.view or clients.view, and none of those imply view. Exact-client/global-context and complete-authority delegation rules are unchanged. Existing administration renders only definitions the real backend returns; there is no new destination or connection action. Metadata reads require both current clients.view and integrations.view on the same client. Writes, credentials and synchronization remain later backend work.

## Implemented connection metadata reads

Migration 15 stores one connection per Meta Ads ad account, with permanent connection/client/provider/account ownership and globally unique provider/account identity. Account IDs are canonical positive decimal adapter identifiers of 1–32 digits, private to storage; leading zeros are rejected. The adapter must normalize and verify them before any future insert. IDs, ownership and creation time cannot be updated. Positive int64 revisions and generations support later optimistic writes and stale-work fencing; this slice supplies no lifecycle writer. No connection rows are seeded, and there is no HTTP create/update/delete route.

| Request | Contract |
| --- | --- |
| `GET /api/v1/clients/:id/integrations` | `{data: [...], page: {limit, next_cursor}}`; default limit 25, range 1–100; optional canonical versioned client-bound UUID keyset cursor; ascending connection ID order. |
| `GET /api/v1/clients/:id/integrations/:connection_id` | `{data: {...}}`; no query parameters. |

Each connection exposes exactly `id`, `client_id`, `provider`, `state`, `revision`, `created_at`, `updated_at`. Revisions are canonical decimal strings, preserving int64 precision in JavaScript; timestamps are UTC with PostgreSQL microsecond precision. Provider is `meta_ads`. State is a stored fact: `pending`, `connected`, `disconnect_pending`, `revocation_failed`, `disconnected`, or `reauthorization_required`. A read does not verify remote health or infer success from timestamps. Generation, account ID, credentials/ciphertext, OAuth state/code and raw provider errors never enter the projection.

Both guarded readers take shared advisory transaction lock `871092650209` before fresh authorization and real-client lookup. They require independent current `clients.view` and `integrations.view` for that client; knowing a foreign connection ID grants nothing. Queued reads observe committed assignment/permission revocation and disablement. Missing, foreign and unauthorized resources share 404; malformed requests return 400; absent/disabled sessions return 401; authenticated non-GET requests return 405 with `Allow: GET`. Responses use `Cache-Control: no-store`; internal failures have fixed errors/logs without raw database/provider details. Reads write no audit event. Archived clients retain authorized connection history, and a client without connections returns an empty array.

Migration 15 adds client-defined `integrations.view` as catalog key 34. Only Initial Administrator receives its explicit seed. Custom, Finance and Viewer roles are unchanged; administration can delegate it under existing complete-authority rules. Runtime receives EXECUTE on the two guarded functions, no table privileges, and no ownership-helper access; PUBLIC execution is revoked. Apply migration and reviewed runtime grants before API rollout. Metadata survives disconnect; no deletion API exists. Down takes the exclusive lifecycle lock and refuses any connection or nonseed/revoked integration-view permission history. Empty down/up works, and recreated readers require regranting.

Before accepting credentials or making provider requests, #25 must record and verify the actual Meta API version, fixed endpoints, minimum read scopes, account-ownership proof, reporting contract and OAuth/revocation fixtures. Durable credential persistence needs key provisioning/global encryption budgets and bounded rotation/restore proof. Future lifecycle writers require fresh manage plus clients.view, immutable ownership, revision/generation fences and typed transactional audit events. Parent #24 remains incomplete.

## Remaining parent work: design only

The following decisions describe required lifecycle work beyond encryption and metadata reads. Parent #24 remains open with all acceptance boxes incomplete until implemented and verified.

| Boundary | Required behavior and evidence |
| --- | --- |
| Provider approval | #25/#26/#27 record concrete provider, minimal scopes, account ownership/verification, fixed endpoint policy and retention before accepting credentials. No generic normalized metrics schema until a provider consumer needs it. |
| Authorization | View reads are implemented above. Future manage operations additionally require the real session/CSRF contract and fresh checks before lookup, decryption and writes. No implicit view from analytics/manage access. |
| Persistence | Metadata ownership, uniqueness, revisions/generation and narrow read privileges are implemented above. Separate encrypted credentials/sync state still need explicit keys/ciphertext limits, enforced generation fences, global encryption budgets and rotation/backup retention proof. History-preserving rollback must refuse populated data destruction. |
| Metadata API | List/detail are implemented above. Provider-specific management operations and safe enumerated failure projections remain future work. No route claims connection/sync success without verified work. |
| OAuth | Single-use expiring random state and PKCE bound to actor/session/client/provider, fixed exact callback origin, current authorization at completion and verified account ownership. Exchange secrets backend-only; exclude code/state/query strings from ingress and application logs; reject reuse, expiry, actor changes and unexpected callbacks. |
| Outbound access | Fixed provider-owned HTTPS allowlists, verified TLS, no arbitrary caller-supplied URLs. Deny private/link-local/loopback/metadata destinations, unsafe DNS resolution and cross-host redirects. Bound timeouts, response bytes and pagination. Deployment egress enforcement complements adapter validation. |
| Disconnect | Disable local credential use/sync immediately, increment generation and fence in-flight work. Remote revocation remains pending/failed until provider evidence confirms it. Keep only encrypted material needed for bounded revocation; terminal failure must expose honest manual recovery. Do not report remote success from local deletion. |
| Synchronization | Explicit queued/running/succeeded/failed/action-required outcomes, attempt/deadline/page budgets, idempotent ingestion keys and checkpoint transactions. Retry only transient failures with bounded backoff; auth/permission failure requires action. Stale or disconnected generations cannot publish metrics/checkpoints. No empty/failure response becomes a successful sync. |
| Audit | Typed, allowlisted transactional connection changes and safe sync outcomes through existing infrastructure. No credentials, callback codes/state, account labels, raw provider errors/responses or customer payment data. Safe activity projections require separate permission policy. |

Next slices must supply deterministic provider fixtures, callback/revocation failure tests, storage privileges/migrations, restart/rotation/restore proof, retry/idempotency tests and real authorization/audit behavior. Concrete remote provider access and production deployment remain separately authorized work. The overview continues to display honest unavailable integration states.

## Verification

Metadata unit tests cover bounded filters, canonical client-bound cursors, exact int64 revision strings and safe stored-state/time validation. Real PostgreSQL tests prove independent grants and IDOR denial, empty/archived results, all stored states, read-only HTTP, seven-field projection, no read audit/secret leakage, PUBLIC/runtime privileges, immutable ownership/canonical accounts, retained-history rollback and queued revocation/disablement for both readers. Full migration/catalog regressions include version 15; container smoke checks prove runtime grants and anonymous routing. Existing browser/finance regressions remain required.

The credential suite checks binary interoperation with ordinary GCM, every-byte tampering, cross-client/connection/provider/purpose substitution, retained/missing/wrong keys, authenticated rewrap, strict parser limits, buffer ownership, concurrent nonce generation and default formatting/logging/JSON redaction. Fuzz targets exercise bounded envelope and key-ring parsers; their seeds also run in ordinary CI race tests. Full backend race/vet/static builds and final-head CI accompany the PR. Database/container/browser gates verify existing behavior; they do not claim provider lifecycle coverage for this slice.
