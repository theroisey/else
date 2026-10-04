# Trusted credential rotation command

Current standard distribution: one `else` container includes PostgreSQL, Go-served React/API, and the supervised analytics worker. Startup automatically applies migrations/grants and provisions a durable protected integration keyring. API/worker run as UID 65532; restricted root supervision and separate PostgreSQL/migrator identities handle initialization. See [Docker operations](docker.md) for current installation commands. Standalone source/operator examples and older CI evidence below retain their original scope.

[Issue #88](https://github.com/theroisey/else/issues/88) adds `cmd/rotate-integration-credentials`, a trusted operator transport for the [bounded rotation library](integration-rotation.md). Each confirmed invocation performs exactly one page. Parent #24 remains incomplete.

## Authority and prerequisites

Only externally authorized operators provisioned with protected keys and runtime database access may execute this command. Those deployment credentials are privileged application-writer authority. `--actor` supplies **trusted audit attribution**, not end-user authentication: the database checks that actor's active/current `clients.view` and `integrations.manage` grants on the exact active client, including empty pages. Never expose execution to a public request, untrusted user-selected actor or job payload.

Use the authoritative database with migrations through 20 for mutation, through 21 for inventory, and existing reviewed [runtime grants](../backend/scripts/grant-runtime.sql). The command uses only `DATABASE_URL`; it never bootstraps, migrates or grants permissions. Provision its URL through protected deployment configuration using the existing verified TLS rules. Never pass it or key material as a CLI argument or print configuration.

`INTEGRATION_KEYRING_FILE` is mandatory and uses the [protected Linux source contract](integration-key-startup.md): an absolute clean path to a readable single-link regular file owned by the effective user or root, mode 0400/0600, bounded size, strict immutable ring and no final-component symlink. Unsupported platforms fail configured loading. Provision fresh independent active material plus all required retained keys through external secret management; never use committed test fixtures. Exclude stale old-key writers externally.

`INTEGRATION_KEYRING_MODE` defaults to `normal`; explicitly declared recovery uses `restored`. Startup applies the configured mode before rotation; the library repeats normal read-only preflight per page. Keys register only through existing audited reservations. These checks cannot detect undeclared rewinds or material absent from restored accounting history.

## Invocation and packaging

Issue #90 adds a separate [read-only live retention inventory](integration-key-inventory.md): `--inventory --actor UUID` requires both global view/manage grants and rejects all mutation flags. It observes stored, eligible and excluded counts without encryption, writes or audits; normal mode permits exhausted active material. All mutation prerequisites and confirmation rules below remain in effect.

From `backend`, build with the repository's pinned Go toolchain:

```sh
go build -mod=readonly -trimpath -o /tmp/rotate-integration-credentials ./cmd/rotate-integration-credentials
/tmp/rotate-integration-credentials --help
```

After external operator authorization and protected configuration are established, request one page:

```sh
/tmp/rotate-integration-credentials --actor "$OPERATOR_ACTOR_ID" --client "$ROTATION_CLIENT_ID" --limit 25 --confirmed
```

Accept only unique known space-separated flags. Actor/client and optional `--after` require canonical lowercase nonzero UUIDs; `--limit` is canonical decimal 1–100. Missing confirmation, duplicate/unknown/extra/missing flags, `--flag=value`, leading-zero limits and malformed values fail before configuration lookup, file reads or database access. Sole `--help` prints fixed usage without configuration access. Each page gets a fresh server-generated audit correlation ID.

The single root application image contains the static command and standard CA roots, whose API/worker run as `65532:65532`. For a standalone invocation explicitly use `--user 65532:65532`; the distribution entrypoint otherwise starts the restricted root supervisor. Invoke the same pinned image with `--entrypoint /rotate-integration-credentials`:

```sh
docker build --target production --tag roisey-else:reviewed .
docker run --rm --network none --entrypoint /rotate-integration-credentials roisey-else:reviewed --help
```

Supply any managed-build CA using existing BuildKit secret guidance in [Docker documentation](docker.md). The application image contains this command; default Compose startup supervises PostgreSQL, API, and analytics worker. There is no separate published operator image. Authorized operator execution must provision verified network access, protected database configuration, CA trust and a read-only key mount readable by its effective UID. This document does not authorize production execution.

The operation context is 45 seconds and honors SIGINT/SIGTERM; the library retains its thirty-second page context and separate transaction cleanup bounds. Exactly one `Run` occurs, with no automatic retry, loop, durable cursor, actor substitution or key-mode change.

## Reports and reconciliation

Stdout contains one bounded JSON page report: fixed `status`/optional `error_code`, actor/client UUIDs, server correlation ID, and `rewrapped`, `resume_after`, `pending`, `page_complete`, `more`. No provider data, plaintext, envelopes, key identities/material, URLs, file paths or raw errors appear. Startup/argument/unexpected failures instead emit fixed `status: attention_required` and `error_code` JSON to stderr.

| Outcome | Exit / report |
| --- | --- |
| Reported successful page or sole help | 0; page status `page_complete` |
| Invalid invocation / missing confirmation | 2; `integration_rotation_invalid` |
| Key configuration / source / preflight failure | 1; `integration_rotation_key_configuration_failed`, `integration_rotation_key_source_failed` or `integration_rotation_key_preflight_failed` |
| Database configuration / connection failure | 1; `integration_rotation_database_configuration_failed` or `integration_rotation_database_unavailable` |
| Denied/missing client, stale revision or mid-page exhausted capacity | 1; page status `attention_required`, with `integration_rotation_missing`, `integration_rotation_conflict` or `integration_rotation_exhausted` |
| Other page failure | 1; page status `attention_required`, `integration_rotation_unavailable` |
| Failed/short output write or unexpected failure | 1; stderr `integration_rotation_output_failed` or `integration_rotation_internal_error` |

Inspect exit status and the complete report together. `rewrapped` counts only positively confirmed commits; `resume_after` stops at the last confirmed UUID and `pending` identifies the first unconfirmed candidate. Earlier commits survive later failure. Reservations remain irreversible even when a credential write rolls back or its outcome is uncertain. A failed process or missing/truncated report is **not** evidence that nothing committed.

Stop after failure and reconcile authoritative credential revisions/generations, lifecycle and protected audits through freshly authorized trusted reads. Correlation links existing safe reservation/mutation events. With lost output, reconcile using trusted actor/client context, operation window and storage/audit evidence; the correlation ID may also be lost. Never retry or advance a cursor assuming an error means rollback. A denied/missing row or empty candidate scan alone does not prove prior success.

After reconciliation, another explicit confirmed invocation may use `--after` with the verified last committed UUID. An explicit restart from an empty cursor skips rows currently on active material. Cursors confer no authority or snapshot guarantee: reset on client/key changes or concurrent changes behind the cursor. Every invocation freshly checks grants and source prerequisites.

## Declared restore transition and retention

The first audited reservation in restored mode can register fresh active material **even when the first credential write fails**. Subsequent restored invocations reject that now-registered active material. Verify durable reservation, storage and audits, establish the declared recovery transition, then explicitly configure `normal` for further pages while excluding stale writers. The command never auto-switches, rewinds accounting or selects old active material to make a retry pass. An empty restored page registers nothing and does not establish that transition.

`page_complete: true` describes this page; with `more: false` it reaches only the observed end of the eligible client scan. Disabled/obsolete/other-client credentials, concurrent writes and backups still require retained keys. No report permits retirement, proves provider health or revokes compromised provider credentials. [Live inventory](integration-key-inventory.md) supplies counts only; backup expiry and verified restore/retirement proof remain separate work.

## Verification

Unit/race tests cover pre-configuration confirmation/grammar, help/cancellation, fixed panic/error classification and failed/short output. Disposable PostgreSQL tests use the same orchestration as the binary with synthetic protected files and runtime roles: bounded paging/resume/restart, fresh audit correlation, foreign empty-client denial, revoked grants, rejected source/configuration/preflight without accounting changes, restored-to-normal transition, failed first restored write with irreversible registration, partial commit failure/reconciliation and output loss after a known commit. Existing library tests retain deeper race, quota, retention and migration proofs.

Container CI uses the same tested nonroot application image with the explicit rotation entrypoint and executes the actual binary for help, missing confirmation, protected loading without database configuration, and malformed/public/symlink/missing sources. All five exact-head gates remain required. No real credentials, provider calls, production operator execution or deployment is performed.

A real compiled-process PostgreSQL test closes the stdout pipe before execution and verifies exit 1 with fixed stderr after exactly one committed row. The command ignores SIGPIPE so this write failure reaches the documented reconciliation path; it never retries the committed page.
