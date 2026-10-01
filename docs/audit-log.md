# Audit storage and atomic mutations

Issue [#7](https://github.com/theroisey/else/issues/7) introduces internal audit infrastructure. There are no audit read endpoints, customer activity, authenticated writes, or frontend changes. Later domains must route significant successful mutations through this contract and enforce their own authorization/client scope before changing data.

## Transaction contract

`internal/audit.WithTransaction(ctx, pool, mutate)` owns a pgx transaction. The callback receives `audit.Queries` (Exec/Query/QueryRow), computes the business mutation and returns a typed `audit.Event`. It cannot type-assert that capability to pgx.Tx or call lifecycle methods. Reviewed callback SQL must not contain transaction-control statements, session changes or arbitrary caller SQL; this helper does not sandbox trusted application code. Close query rows before returning and never retain the capability.

The helper validates/serializes the event, inserts it in the same transaction, then commits. Missing correlation fails before mutation. Callback errors, invalid events and insert errors roll back business changes; cancellation and panic also trigger bounded cleanup with an uncancelled context. pgx discards unusable connections on rollback failure. Commit errors may mean an unknown outcome, so future domain idempotency/reconciliation policy must govern retries. Do not blindly retry financial writes.

`audit.Error` prints a fixed operation message and preserves its cause for errors.Is/As. Never log the unwrapped driver/callback cause, SQL or arguments. Application services translate errors to existing safe external error codes. An audit failure is a failed mutation, never best-effort logging. Failed security actions and standalone operational events need separately scoped policies; this contract records successful mutations only.

## Payload and correlation policy

Events contain a server-owned resource kind constant, resource UUID, one of created/updated/archived/deleted, an explicit actor, optional client UUID, before/after snapshots and metadata. Names use `<resource>.<action>`. The initial action catalog can expand only through reviewed domain work. Actor/client UUIDs have no speculative FK until identity/client schemas exist; consumers validate their existence and authorization when those domains are implemented.

Before authentication, trusted internal operations explicitly use `Actor{Kind: audit.System}` with no user ID. This grants no public authorization and adds no mutation endpoint. Future authenticated adapters supply `audit.User` and the verified user UUID; actor IDs must never come from a request body. Deleted actors must retain historical identifiers when identity retention is designed.

Snapshot fields are initially restricted to optional `Exists` boolean and nonnegative int64 `Revision`. Nil snapshots persist as JSON null. Metadata requires one source enum: http/job/cli. No arbitrary map, raw DTO, free text, password, token, connection string, IP or user agent field exists. Resource kinds must be reviewed code constants, never caller input. Future domains add reviewed typed fields and matching database allowlists in new migrations; don't serialize whole entities. These record markers do not pretend to implement domain-specific before/after details.

Each snapshot is bounded to 1024 serialized bytes and metadata to 256; SQL checks also restrict JSON shape, keys, types and sizes. The fixed types are well below these limits. Unit tests demonstrate sensitive unknown DTO fields cannot survive typed serialization; PostgreSQL tests reject raw SQL attempts to bypass the allowlists.

`internal/correlation.New(ctx)` generates a fresh server ID for HTTP or an internal job/CLI operation. HTTP RequestMiddleware creates it, returns X-Request-ID and carries it through the application context into audit INSERT. It never accepts an incoming ID. Jobs generate one context per logical operation and preserve it through database calls. The event cannot supply or replace its own correlation field.

## Storage privileges and rollout

Migration 000002 creates app.audit_events with database-generated UUID, TIMESTAMPTZ, schema version 1, actor/event/resource/client/correlation fields, snapshots, metadata, constraints and resource/client/actor/time/request indexes. Sessions use UTC; TIMESTAMPTZ stores the instant independently of the server's display timezone. No runtime column grant includes ID, occurred_at or schema_version.

Run migrations using the distinct migration owner before starting a consumer. Then explicitly provision the deployment's runtime role, substituting its identifier if it differs from this local example:

```sql
GRANT USAGE ON SCHEMA app TO else_runtime;
GRANT INSERT (actor_kind, actor_user_id, event_name, resource_kind, resource_id,
              client_id, request_id, before_state, after_state, metadata)
ON app.audit_events TO else_runtime;
GRANT EXECUTE ON FUNCTION app.audit_snapshot_allowed(jsonb) TO else_runtime;
```

The validator is immutable, runs with invoker privileges and a fixed pg_catalog search path. It grants no access to stored events. Runtime has no audit SELECT, UPDATE, DELETE or TRUNCATE, no table/schema ownership, no migrator membership and no trigger-management permission. INSERT uses no RETURNING, which would require read privileges. There are no blanket/default grants to future tables. A later audit viewer must define RBAC and narrowly scoped reads separately; no public reader role is introduced here.

The statement-level ALWAYS trigger rejects UPDATE/DELETE/TRUNCATE even if their DML privileges are accidentally broadened. The runtime cannot disable/drop it or change session_replication_role. Migration owners/superusers can alter or drop storage and remain a protected operator trust boundary; this is not tamper-proof storage against administrators or cryptographic evidence. Keep migration credentials out of the runtime process. Database permissions cannot force every future application writer to call this helper: domain reviews/tests must verify audit coverage.

Rollback takes an ACCESS EXCLUSIVE lock and refuses any nonempty audit table, preserving history and migration version. An empty audit migration can be rolled down/up; grants must be reapplied after recreation. The baseline then rolls down only when app is empty. No CASCADE or automatic history deletion exists. Retention/export/legal deletion policy requires a separate reviewed Issue and privileged maintenance procedure; ordinary UI/runtime workflows cannot delete history.

## Verification

Go formatting, vet, race tests, static builds and tagged-suite compilation are local checks. The disposable PostgreSQL suite tests success, callback/insert/validation/cancellation/panic rollback, correlation from HTTP to stored event, actor/client values, payload injection, restricted and accidentally broadened grants, and nonempty rollback refusal. The migration suite performs complete empty up/down/up across both migrations. Compose checks apply the same explicit runtime grants and denial probes while testing runtime containers.

[CI run 36858914108](https://github.com/theroisey/else/actions/runs/36858914108) passed frontend checks, backend checks, PostgreSQL integration and full Compose development/runtime verification for implementation revision `cea4720d25d096c489326035b950e1e1a1bfec24`. Publication was correctly skipped on the PR. Local Docker Hub pulls still hit the unauthenticated rate limit; GitHub supplied the runtime evidence. [PR #41](https://github.com/theroisey/else/pull/41) is the review path. No production deployment is performed.
