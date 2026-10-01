# Client records and API

Related Issue: [#13](https://github.com/theroisey/else/issues/13), owner-merged in [PR #48](https://github.com/theroisey/else/pull/48). This backend slice provides the contract consumed by [the client interface](client-interface.md) in #14. Test data remains separate from real application records.

## Authorization and archival

Use the existing identifiers: global `clients.create`, and exact-client `clients.view`, `clients.update`, `clients.archive`. The issue's deletion wording maps to archival. Role names, creator identity and knowledge of a UUID never grant access. Existing role assignment/delegation is the only access mechanism; there is no second membership system or implicit creator grant. A create-only user can create but cannot read the resulting profile until separately authorized.

Collection reads require some effective `clients.view` grant and return only clients for which that actor is allowed. Detail and mutation functions check the exact client inside the database. Missing and unauthorized detail/update/archive IDs both yield 404 `not_found`. No hidden totals, unauthorized cursors or contact values are exposed. Global view grants cover all real client records; scoped grants match only their exact ID.

Archive requires `clients.archive`, current revision and explicit confirmation. It preserves the profile, contacts, tags, ID and existing assignment/audit history. Authorized historical reads remain possible; edits, repeated archive and new client-scoped assignments are refused. Assignment removal remains available under existing delegation policy. Archive and assignment creation use the same authorization advisory lock, preventing a blocked assignment from observing pre-archive state. No physical client deletion, restore, arbitrary ownership transfer or bulk operation is exposed.

## Contract

All routes use the existing cookie session. Writes additionally require exact Origin, JSON content type and the session's CSRF token. Responses use no-store and safe existing envelopes; write bodies are limited to 64 KiB, with unknown fields and trailing JSON refused.

| Method and route | Input | Result |
| --- | --- | --- |
| `GET /api/v1/clients` | Optional query below | `{data: Summary[], page: {limit, next_cursor}}` |
| `GET /api/v1/clients/:id` | Nonzero UUID | `{data: Client}` |
| `POST /api/v1/clients` | Profile | 201 `{data: {id, revision: 1}}` |
| `PUT /api/v1/clients/:id` | Profile plus positive `expected_revision` | `{data: {id, revision}}` |
| `POST /api/v1/clients/:id/archive` | `{expected_revision, confirm: true}` | `{data: {id, revision}}` |

Lists default to 25 records, `status=active`, `sort=id`. `limit` is 1–100; `cursor` is the last visible UUID from the previous page. `sort=id` or `sort=-id` provides stable UUID ascending/descending keyset order. `status` accepts `active`, `archived`, `all`; `q` is a literal case-insensitive name substring of at most 100 characters; `tag` is an exact normalized tag of at most 40 characters. Duplicate/unknown/empty query parameters and invalid bounds are refused. Keep filters/sort fixed while paging; reset the cursor when they change. There is no snapshot guarantee across independent requests.

Summary fields: `id`, `name`, `legal_name`, `status` (`active`/`archived`), `revision`, `tags`, `created_at`, `updated_at`, `archived_at` (nullable). Detail adds `website`, `notes`, `contacts`. List responses intentionally omit contact/profile detail values. All timestamps are UTC instants; consumers convert for display.

Profile fields:

- `name`: required, trimmed 1–200 Unicode characters.
- `legal_name`: optional, trimmed at most 200 characters.
- `website`: optional HTTP/HTTPS URL at most 2048 characters, with host and without user credentials or fragment. Stored only; the server never fetches it.
- `notes`: optional, trimmed at most 4000 characters. Profile strings reject control characters, including line breaks.
- `contacts`: up to 20 ordered `{name, email, phone}` records. Name is required, 1–100 characters; optional email follows existing canonical ASCII email policy; optional phone is trimmed, at most 40 characters. No opaque contact metadata is accepted.
- `tags`: up to 20 distinct trimmed lowercase labels, each 1–40 characters; normalization duplicates are invalid.

Optional strings default to empty; missing/null arrays normalize to empty arrays. PUT replaces the full profile/contact/tag set atomically; omitted optional fields clear their prior values. It is not a patch. Child contact positions and tags have client foreign keys and unique keys. Tax/address/contracts and business modules remain separately scoped work.

Every successful update/archive increments the revision once. A stale revision or archived target returns 409 `conflict`; reload before reviewing another mutation. Invalid inputs return 400 `invalid_request`; missing session is 401; collection/create denial is 403 `permission_denied`. Unexpected errors return generic 500 without raw SQL, profile values or infrastructure details. ClientsArchive remains the established identifier; no `clients.delete` alias is added.

## Scope history and migration

Additive migration `000006_create_clients.sql` creates clients, normalized contacts/tags, indexes and a `client_scopes` registry. Existing scoped `user_roles` IDs are backfilled into the registry and receive a foreign key; no client names/profiles are invented. Legacy orphan scope IDs remain grant history and expose no client record. Client creation generates a fresh ID in trusted application code; callers cannot supply an ID to adopt another scope. Operators importing a real record under an existing legacy scope must verify that scope's historical assignments first through a separately reviewed owner migration.

Every real client references its registered scope. An ALWAYS insert/update trigger requires new active scoped assignments to reference an active client, under the shared authorization lock. Global assignments remain unchanged. Existing legacy grants and their identity representation are preserved; all client reads still require both a real record and exact authorization. The runtime cannot read/write these relations, execute unchecked document helpers, manage triggers or invent scope rows directly. It receives only EXECUTE on authenticated list/read/write functions with fixed `pg_catalog` search paths.

Migration adds a foreign key to the existing assignment relation and locks it while validating/backfilling. Existing migration lock/statement timeouts remain enforced; schedule an appropriate maintenance window for large grant history. Apply migrations as the separate owner, reapply reviewed runtime grants, then start the new API. Existing identity/administration contracts are unchanged, except that new scoped assignments require an actual active client. Existing browser/integration fixtures now provision explicitly synthetic real scope records; no fixture mode is exposed by the product.

An empty/scope-only down/up preserves old grants. Down refuses real client rows or client audit history, retaining the applied version/data. After populated rollout, use a forward fix or a compatible API with the additive schema. Do not remove assignment guards or physical records to force rollback. No new dependencies or runtime configuration are required.

## Audit and verification

`client.created`, `client.updated`, `client.archived` share `audit.WithTransaction` with profile/contact/tag/scope writes. Before/after snapshots contain existence and revision only. Archive's existence marker remains true because the record is retained. Actor/client/resource IDs and server-owned request IDs provide correlation; names, contacts, websites, notes and tag values never enter audit snapshots, URLs generated by the service, or application logs. Filters are not logged; route labels replace dynamic IDs. Audit insertion failure rolls the entire mutation back.

Local verification passes formatting, vet, race/unit checks, static Go builds and the full disposable PostgreSQL 17.11 integration suite with race detection. Tests cover strict/bounded validation, global/scoped/absent permissions, list/detail/write IDOR, literal filters and both cursor directions, no implicit creator access, revision races, archival/history, assignment-after-archive locking, runtime storage denial, create/update/archive audit rollback, scope-only migration compatibility and populated rollback refusal. The existing four real API browser flows also verify administration compatibility against this schema. CI supplies required PostgreSQL 18, container and pinned browser proof; local Docker pulls remain rate-limited. No production deployment is performed.
