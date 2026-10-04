# GA4 setup, durable synchronization and stored reports

The React [workspace guide](ga4-workspace.md) documents pending-property creation, key installation, explicit synchronization and measured reporting screens.

Continues existing [#26](https://github.com/theroisey/else/issues/26). The [collector](ga4-adapter.md) now has an application path: locally validated and encrypted service-account setup queues PostgreSQL work; a separate Go worker collects complete aggregate tables and publishes a stored snapshot. HTTP dashboard/setup requests never call Google. No connection, credential, job or measured success is seeded.

## API and permissions

All routes use existing cookie/current-identity authentication and `Cache-Control: no-store`. POST also requires the existing exact origin, JSON content type and CSRF token. Bodies are limited to 32 KiB, reject unknown/case/duplicate/extra fields and never echo private input.

| Operation | Route | Input / authority |
| --- | --- | --- |
| Create pending GA4 connection | POST `/api/v1/clients/{client}/integrations/ga4` | `property_id`; current `clients.view` + `integrations.manage`, active client |
| Install/replace key and queue | POST `/api/v1/clients/{client}/integrations/{connection}/ga4/credentials` | `revision`, `since`, `until`, `credential_json`; same authority |
| Queue explicit period refresh | POST `/api/v1/clients/{client}/integrations/{connection}/ga4/sync` | `revision`, `since`, `until`; same authority |
| List safe GA4 report connections | GET `/api/v1/clients/{client}/analytics?after={id}` | Current `clients.view` + `analytics.view`; 25-row keyset page, optional `next_id` |
| Read period workspace/status | GET `/api/v1/clients/{client}/analytics/{connection}?since=YYYY-MM-DD&until=YYYY-MM-DD` | Same authority; one stored complete workspace |

The integration-local GET `.../integrations/{connection}/ga4?since=...&until=...` uses the same protected read operation. Analytics view independently permits only safe GA4 report metadata; it does not imply `integrations.view`, management, credential/account access or another client's scope. Existing connection list/detail/disconnect permissions remain unchanged.

Create returns the existing seven-field pending connection DTO (201), with immutable globally unique property binding and transactional audit. Setup returns a safe queued job ID/state/current connection revision (202). Property/key values never enter responses, logs or audit. Protected encryption keys remain optional for read-only API startup; without them, authorized setup is unavailable. Supply the existing protected `INTEGRATION_KEYRING_FILE`/mode configuration for setup and the worker.

Creation and credential installation are distinct audited operations. Failed installation may leave honest pending metadata, which can be reloaded and completed or locally disabled. Setup burns an independently committed encryption unit before encryption; it atomically writes the credential, cancels/audits older jobs, advances credential generation and pending connection revision, and queues replacement work. Audit/commit failure discards that transaction's credential/job/state changes and does not refund encryption accounting. Reload checkpoints after uncertain outcomes; do not automatically replay credential writes.

## Durable work and fences

Migration 23 adds private `analytics_sync_jobs` and `analytics_snapshots`, with no direct runtime table privileges. Reviewed SECURITY DEFINER entrypoints have fixed search paths/UTC settings and PUBLIC execution revoked. Provision the updated runtime grants after migration; migrations never run inside API requests.

One queued/running job per connection is enforced by a partial unique index. Transactional PostgreSQL admission allows at most two unexpired running leases across replicas. Each claimed job has a random lease token, 180-second deadline, explicit immutable client/connection/period/requesting user and connection/credential generation/revision checkpoints. An operation lasts at most 150 seconds, including a collector capped at 120 seconds. Crash-abandoned leases can be reclaimed at most three attempts with new tokens; expired tokens cannot publish. Ordinary provider failures are recorded as `provider_unavailable`, with explicit retry required; there is no blind authentication/quota retry or refresh loop.

Claim/audit commits before any credential use or external work. The worker rechecks current client/manage authority and checkpoint under a short shared lifecycle lock while decrypting/parsing the bounded key. It closes that transaction before network work and rechecks the durable fence before every token/Admin/Data request. No transaction or lifecycle lock spans external requests, so dashboard/authorization writers are not held behind 120-second network operations. Revocation cannot retract an already issued request; fresh publication checks prevent revoked, disabled, archived, disconnected, replaced, expired or reclaimed work from publishing. Rotation/revision changes conservatively fence old jobs.

All five tables must pass current definitions, exact period/timezone, complete bounded pagination, quality and privacy checks. Publication and mandatory job/snapshot/connection audit are one transaction. Success updates connected state and last-success time; failure writes a safe enumerated job reason without a snapshot or manufactured zeros. Same connection/generation/period refresh replaces one deterministic snapshot and increments its revision. Reads expose exact decimal strings, selected metric definitions, stored tables and honest job/freshness information; no provider account, lease, generation, raw response or diagnostic crosses the public boundary.

## Worker and retention

`/analytics-worker` is built into the **same application image** as `/api`, frontend assets and operator tools. Its default command polls durable work, sleeping five seconds when idle/unavailable; `--once` processes at most one job and an expired-snapshot batch, then exits. No endpoint/token/key flags exist. It loads the protected key source, performs existing declared-restore preflight and opens a two-connection runtime PostgreSQL pool. Supervise the worker or invoke `--once` through a managed scheduler using the same reviewed image and runtime credentials/key mount. API startup does not start it or make external requests.

Initial report periods are explicitly requested inclusive property-local dates, at most 31 days. There is no rolling-period/recurring provider schedule yet; future scheduling must preserve property timezone and quota policy. The source worker itself is stateless; leases and snapshots are durable in PostgreSQL. Deploying/running it against a real provider is a separate authorized operator action and requires permitted egress to the three fixed Google hosts.

Measured snapshots expire 90 days after their last successful refresh and become unreadable at that boundary. The worker prunes at most 100 expired snapshots per audited transaction. Credential, account, encryption accounting, job and audit history remain retained. A snapshot is at most 2 MiB; the strict SQL and Go DTO boundaries verify exact client/connection/period, compiled columns, current types and privacy/number limits. Public staleness is true when no usable snapshot exists or its last success is at least 24 hours old. A failed refresh can expose an earlier valid snapshot with its earlier success time and current failed status; no failure becomes fresh success.

Migration down refuses any job, snapshot or synchronization/snapshot audit history; it never cascades populated analytics data. Earlier migration-specific rollback tests explicitly reach their own boundary before comparing unchanged history. Logical recovery fingerprints enumerate the new tables automatically; full latest-artifact rehearsal remains required.

## Current evidence

Focused real PostgreSQL tests pass for setup/pending state/encryption accounting, strict authenticated/CSRF/body handling, measured exact reads, independent analytics permissions, client isolation, deterministic replacement, two-replica admission, crash/expired/replaced leases, revoked grants, audit rollback and 90-day retention. Ordinary Go race tests pass. Full regression/container/browser/exact-head CI remains required after final wiring. Synthetic provider fixtures and deliberately malformed worker keys do not prove live property authorization, real Google reporting, deployed egress or production worker supervision.
