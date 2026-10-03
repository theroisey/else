---
type: decision
status: implemented-pending-owner-review
created: 2026-10-03
tags:
  - releases
  - backend
  - security
  - devops
---

# Immutable Build Metadata and Release Reads

Issue #92 records policy before implementation under parent #29. It follows owner-merged inventory #90 / PR #91 at `2f797a5`; both development branches synchronized. No provider/API version is guessed to unblock roadmap work.

Only a current cookie session plus freshly checked global releases.view may read GET /api/v1/releases. This uses existing identity/authorization functions, adds no schema/seed and creates no read audits. Actor/scope/evidence sources are not caller-selectable; methods/queries/extra paths fail safely. Public health/readiness omit protected metadata.

The running API stamp is immutable compiler input: sha-fullRevision version, full lowercase nonzero 40-hex commit, canonical UTC seconds. Treat the complete stamp atomically; partial/malformed/plain local builds are unavailable with null values. Runtime configuration cannot replace it. A strict build helper validates before Go/linker invocation, including timestamp correctness and unsafe shell input refusal.

CI derives the tested checkout revision and one UTC build timestamp. Docker/Compose-CI pass those exact inputs; actual non-root production API reports them through protected synthetic sessions. A separate compiled-process/PostgreSQL test proves immutable stamping despite runtime override attempts. Labels alone are insufficient proof.

Latest release, image provenance and deployment remain independently unavailable until authenticated authoritative sources exist. Embedded revision identifies the API binary, not verified registry digest/approved release/deployment success. No remote call, updater, release/deployment audit, new privilege or rollout command is introduced. Frontend follows in a separate coordinated slice; parent #29 remains open until its acceptance is complete.

See [release contract](../../docs/releases.md), [[CI and Publication]], and [[Authorization and Client Scope]].
