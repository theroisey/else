---
type: decision
status: verified-local-awaiting-main-ci
created: 2026-10-05
tags: [releases, security, ci]
---

# Read-Only GitHub Release Evidence

Issue #132 records policy before implementation. The existing main-only, single tested image is the distribution source. Validate server-only GITHUB_REPOSITORY/TOKEN; GHCR latest only discovers an independently hash/OCI/commit checked immutable SHA artifact. Running binary provenance compares that stamp, not the host's container digest. Publication completion comes from the actual successful main CI publication job. Deployment remains unavailable because no rollout source exists.

A coalesced 60-second cache, 10-second manual-refresh floor, five-minute rate-limit backoff, 4-second total timeout, 2 MiB response bound, fixed hosts and a credential-free single approved blob-CDN hop bound requests. Authentication and fresh releases.view checks precede cache/provider access. No schema, permission seed, read audit or deployment mutation.

Current actions/attest v4 is pinned to 1e69f48acb82d1966a394da916b4c1698aa569d6. Promotion exports the exact tested registry digest; CI verifies signature/repository/signer/ref/SHA using gh. Runtime standard-library HTTP retrieves digest-specific attestation presence only and never claims signature verification. Fine-grained PATs work for authorized repository reads; private GHCR requires classic read:packages. Record this compatibility limit precisely rather than requesting broader write permissions or pretending package access works.

See [contract](../../docs/releases.md), [[Immutable Build Metadata and Release Reads]], [[Read-Only Release Center Interface]], [[Single Container Distribution]].

Local verification: complete frontend tests/lint/typecheck/build, actual-API browser workflows, full Go race/vet/command builds, full PostgreSQL integration (including unchanged capacity gate and 28-migration rollback/reapply) and final single-container persistence/offline restore checks pass. Current-worktree candidates remain distinct from exact-commit CI publication. The mandatory Go vulnerability scan awaits CI because the managed workspace blocks the official feed. See [verification report](../../docs/refinement-verification.md); final CI/registry evidence is recorded on the issue before closure.
