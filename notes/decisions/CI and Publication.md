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

[PR run 36852928372](https://github.com/theroisey/else/actions/runs/36852928372) passes all four gates for implementation revision `a8ace7816d29e73ae54cf3cfe1168ea64370fe3c`, including development/static image builds, TLS/role checks, migrations, routing, readiness recovery, persistence, and non-root runtime verification. PR publication is skipped. The tested images export successfully; main-only artifact transfer/registry promotion and a controlled main publication remain unobserved. Issue #6 stays open for those acceptance checks after owner review/merge. No production deployment occurred.

See [CI guide](../../docs/ci.md) and [[Docker Development]].

Local actionlint 1.7.7, shell syntax, Compose CI/production configuration, event/permission/action-pin inspection, and eight simulated publication tests pass. The publication tests reject PR/tag/feature events and unsafe versions, require the tested revision, preserve SHA aliases on repeat promotion, refuse version reassignment, and prevent an older run from changing latest. Registry/network simulation is not publication evidence.
