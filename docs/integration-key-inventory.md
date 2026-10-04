# Live integration key retention inventory

[Issue #90](https://github.com/theroisey/else/issues/90) adds one read-only observation to the [trusted operator command](integration-rotation-command.md). It counts all current stored credential rows across clients, including archived clients, disabled connections and obsolete generations. Parent #24 remains incomplete.

## Authority and invocation

Externally authorize the operator and provision protected key access plus runtime `DATABASE_URL` using the existing deployment contract. These credentials provide privileged application-writer authority; actor UUID is trusted attribution, not authentication. Never expose this command to public requests or untrusted actors/jobs.

Apply migration 21 and the reviewed runtime EXECUTE grant before observation. Supply the same mandatory [protected Linux source](integration-key-startup.md), containing every key required by current stored rows. Known label/material identities must match exactly; aliases and incomplete sources fail. No key is registered, reserved, decrypted or changed.

```sh
/tmp/rotate-integration-credentials --inventory --actor "$OPERATOR_ACTOR_ID"
```

Only these two unique flags are allowed, in either order. Actor must be a canonical lowercase nonzero UUID. Client, limit, cursor, confirmation and other flags are rejected before configuration access. Mutation keeps its existing explicit confirmation grammar.

The actor must have **both current global `clients.view` and global `integrations.manage`**, and remain active. Client-scoped grants cannot authorize aggregate counts. Checks apply even with no credentials, after acquiring the shared lifecycle lock; queued revocation takes effect before observation. Runtime gets only the private fixed-search-path/UTC entrypoint's EXECUTE capability. PUBLIC execution and direct credential/registry access remain denied.

Normal mode allows exhausted active material because observation encrypts nothing. The writer preflight still rejects exhausted material. Declared `restored` mode still refuses an active identity already registered in the restored database; operators must follow the documented recovery transition. Neither mode detects undeclared rewinds or proves external material freshness.

## Complete report

Successful exit 0 emits one bounded JSON object with `status: inventory_observed`, actor UUID, a fresh server correlation UUID and at most eight `keys` entries. Each entry contains only:

| Field | Meaning |
| --- | --- |
| `position` | One-based position in lexicographically sorted labels from this exact protected source. |
| `active` | Whether this source position is the configured active key. |
| `stored_rows` | Decimal string counting all current credential rows on this material. |
| `eligible_rows` | Decimal string counting rows eligible for existing rotation: non-active material, active client, selected catalog pending/connected/reauthorization-required state and matching current generation. |
| `excluded_rows` | Decimal string `stored_rows - eligible_rows`; includes every row already on active material. |

Unused source keys remain present with zero strings. Positions are source-relative, not durable identifiers; compare observations only with the exact source ordering known through protected operator context. Decimal strings preserve full PostgreSQL bigint precision in JSON consumers. Labels, fingerprints, registry IDs, budgets, envelopes, account/client/connection identifiers and key material are absent.

The service uses one read-only transaction with a ten-second work deadline, parent cancellation and separate five-second cleanup. It returns the complete bounded observation or a fixed error with no partial counts. Inventory itself creates no audits or reservations. Failure exits 1 with `integration_inventory_missing`, `integration_inventory_invalid` or `integration_inventory_unavailable`; configuration and output failures retain the command's existing fixed diagnostics. A failed/short output write emits `integration_rotation_output_failed`; discard incomplete output. No automatic retry or mode transition occurs.

## Limits and rollback

Counts describe live rows at observation time. They do not authenticate every ciphertext, inventory retained backups, exclude future writers, detect undeclared restores, prove provider health or authorize key deletion/retirement. Zero rows alone never permit removing a retained key. Keep keys required by backups and separately establish expiry, restore and retirement proof.

Migration 21 down takes the exclusive lifecycle lock and removes only the inventory entrypoint, preserving populated credentials, accounting and audits. Recreated entrypoints require regranting. Migration 20's separate candidate reader and existing writes are unchanged.

## Verification

Disposable PostgreSQL race tests cover global/client/empty/disabled/revoked authority, all-client excluded and active counts, zero positions, aliases/incomplete/malformed sources, exhausted normal material, restored freshness, eight-key bounds, queued revocation, cancellation/resource release, private SQL access, populated rollback/regrant, command reports and lost output without audits or writes. Full empty roundtrip includes 22 versions; [selected-provider catalog](selected-provider-catalog.md) expands eligibility without changing retention claims. Container CI executes the actual non-root binary for mixed-mode rejection and protected/public/malformed/symlink/missing sources. All six exact-head gates and owner review remain required. Tests use synthetic material; no provider traffic or production execution is performed.
