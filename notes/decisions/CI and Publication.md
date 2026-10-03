---
type: decision
status: proposed
created: 2026-10-01
tags:
  - architecture
  - ci
  - security
---

# CI and Publication

Issue [#6](https://github.com/theroisey/else/issues/6) adds frontend, Go, PostgreSQL, and Compose gates plus main-only GHCR publication in [CI PR #40](https://github.com/theroisey/else/pull/40), with separately reviewable frontend fixes in [PR #39](https://github.com/theroisey/else/pull/39). Official Action references use resolved full commit SHAs; package-write permission is isolated to the publication job, which depends on every check.

## Decisions

- Initial publication promotes the exact tested production images through a one-day same-run artifact, without rebuilding. Images carry the tested revision label. Repeat promotion preserves an existing SHA image after checking its label; optional stable version aliases refuse reassignment. Latest advances only if the run's revision is still main's current head.
- PRs never receive registry writes, main publication waits for owner review/merge, and no deployment is added. Branch protection is documented, not modified. Infrastructure traceability uses GitHub runs/artifact digests and GHCR image digests; signed release attestations remain separate work.
- Compose verification uses a committed-source archive, unique disposable project/volume, independent local TLS/credentials, and a random localhost port. It checks both development and static runtimes, TLS/role denials, migrations, readiness recovery, and persistence, then cleans up. It never consumes the developer's local material.
- A companion frontend fix transfers dependency-cache ownership to Node. The original development image installed dependencies as root, which prevents Vite from writing config/dependency caches at runtime.

## Verification boundaries

Docker Hub still rejects local pulls with its unauthenticated rate limit after #37/#38 merged. The original Docker runtime gate remained unverified despite Issue #5 closing on owner merge. Redacted Compose diagnostics exposed `else` as an unquoted reserved SQL keyword; bootstrap provisioning and database documentation now quote it. Related frontend commits are integrated into the backend CI branch for combined verification while retaining the separate frontend PR. Node/Go/nginx and Dockerfile frontend digests are resolved and pinned.

[PR run 36852928372](https://github.com/theroisey/else/actions/runs/36852928372) passed all four implementation gates. The owner merged PRs #39/#40, and [main run 36856821215](https://github.com/theroisey/else/actions/runs/36856821215) passed artifact transfer and GHCR publication. Issue #6 is closed. Later main run 36860620016 published the owner-merged audit revision through the same tested-image path. No production deployment occurred.

See [CI guide](../../docs/ci.md) and [[Docker Development]].

## Stopped PostgreSQL recovery correction

Issue #86 follows owner-merged rotation PR #85 at `49cbe21`. Final-head run 37129297629 passed all five gates, but main run 37131312850 failed Container integration: after intentionally stopping PostgreSQL, Compose `up --wait` reported Running and then the old exited container. Four other gates passed; image publication was skipped. Both development branches synchronized before the correction.

The isolated runner explicitly starts the existing PostgreSQL service once, then polls a local read-only `SELECT 1` up to thirty times with one-second intervals and two-second connection/statement timeouts. Start or readiness failure stops the gate with a fixed diagnostic. This avoids recreating the data volume and suppresses raw start/probe output. The independent HTTP recovery assertion follows; initial creation, persistence, TLS, runtime-role denials, static production containers and protected-key startup remain required. Five shell regression scenarios run in Backend checks; actual recovery still requires the Container integration gate. The corrective PR remains subject to owner review, all five exact-head gates and no agent merge/deployment.

Local actionlint 1.7.7, shell syntax, Compose CI/production configuration, event/permission/action-pin inspection, and eight simulated publication tests pass. The publication tests reject PR/tag/feature events and unsafe versions, require the tested revision, preserve SHA aliases on repeat promotion, refuse version reassignment, and prevent an older run from changing latest. Registry/network simulation is not publication evidence.

Owner merges #39/#40 are verified. Main run 36856821215 succeeded for d050bb76d5e9dcb6241175c946d089c255a32aa7, including tested-image artifact transfer and both SHA/latest uploads. Issue #6 is closed. Both development branches are synchronized before #7. No deployment occurred. See [[../../docs/ci|CI guide]] for registry content digests.
