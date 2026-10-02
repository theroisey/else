# Integration security boundaries

Parent [Issue #24](https://github.com/theroisey/else/issues/24) is deliberately split. [Issue #68](https://github.com/theroisey/else/issues/68) implements only backend credential encryption and in-memory key rotation. Its security policy and the parent lifecycle policy were recorded before code. Providers in #25–#27 remain proposals; no provider connection, credential, metric or synchronization success is created here.

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

## Remaining parent work: design only

The following decisions describe required boundaries, not shipped routes/schema/permissions/adapters. Parent #24 remains open with all acceptance boxes incomplete until implemented and verified.

| Boundary | Required behavior and evidence |
| --- | --- |
| Provider approval | #25/#26/#27 record concrete provider, minimal scopes, account ownership/verification, fixed endpoint policy and retention before accepting credentials. No generic normalized metrics schema until a provider consumer needs it. |
| Authorization | Introduce deny-by-default exact-client `integrations.view/manage`. Both require the same client's `clients.view`; manage additionally requires the real session/CSRF contract. Fresh checks precede real connection lookup, decryption and writes. No implicit grant from analytics access. Prove client/connection IDOR denial and concurrent revocation. |
| Persistence | Separate bounded metadata, encrypted credentials and synchronization state. Require explicit keys/ciphertext limits, immutable client/provider ownership, uniqueness, revisions/generation fences and narrow runtime privileges. New migration; history-preserving rollback refuses populated data destruction. Document data/backup retention and key budgets first. |
| Metadata API | Paginated client connection list/status and provider-specific management operations with consistent safe errors. Expose only allowlisted provider/state/timestamps/enumerated failure codes; never plaintext, ciphertext, codes, raw errors or unbounded provider payloads. No route claims connection/sync success without verified work. |
| OAuth | Single-use expiring random state and PKCE bound to actor/session/client/provider, fixed exact callback origin, current authorization at completion and verified account ownership. Exchange secrets backend-only; exclude code/state/query strings from ingress and application logs; reject reuse, expiry, actor changes and unexpected callbacks. |
| Outbound access | Fixed provider-owned HTTPS allowlists, verified TLS, no arbitrary caller-supplied URLs. Deny private/link-local/loopback/metadata destinations, unsafe DNS resolution and cross-host redirects. Bound timeouts, response bytes and pagination. Deployment egress enforcement complements adapter validation. |
| Disconnect | Disable local credential use/sync immediately, increment generation and fence in-flight work. Remote revocation remains pending/failed until provider evidence confirms it. Keep only encrypted material needed for bounded revocation; terminal failure must expose honest manual recovery. Do not report remote success from local deletion. |
| Synchronization | Explicit queued/running/succeeded/failed/action-required outcomes, attempt/deadline/page budgets, idempotent ingestion keys and checkpoint transactions. Retry only transient failures with bounded backoff; auth/permission failure requires action. Stale or disconnected generations cannot publish metrics/checkpoints. No empty/failure response becomes a successful sync. |
| Audit | Typed, allowlisted transactional connection changes and safe sync outcomes through existing infrastructure. No credentials, callback codes/state, account labels, raw provider errors/responses or customer payment data. Safe activity projections require separate permission policy. |

Next slices must supply deterministic provider fixtures, callback/revocation failure tests, storage privileges/migrations, restart/rotation/restore proof, retry/idempotency tests and real authorization/audit behavior. Concrete remote provider access and production deployment remain separately authorized work. The overview continues to display honest unavailable integration states.

## Verification

The credential suite checks binary interoperation with ordinary GCM, every-byte tampering, cross-client/connection/provider/purpose substitution, retained/missing/wrong keys, authenticated rewrap, strict parser limits, buffer ownership, concurrent nonce generation and default formatting/logging/JSON redaction. Fuzz targets exercise bounded envelope and key-ring parsers; their seeds also run in ordinary CI race tests. Full backend race/vet/static builds and final-head CI accompany the PR. Database/container/browser gates verify existing behavior; they do not claim provider lifecycle coverage for this slice.
