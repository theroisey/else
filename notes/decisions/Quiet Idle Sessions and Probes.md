---
type: decision
status: verified-local-awaiting-main-ci
created: 2026-10-05
tags: [auth, observability, docker]
---

# Quiet Idle Sessions and Probes

Issue #133 removes unconditional 60-second session polling. Existing absolute expiry, focus/reconnect and protected-request denial recovery remain; the server checks current permissions per request. Idle tab revocation is discovered on the next relevant event/request. Preserve working logout and private-cache eviction.

Fast expected successful health/readiness/session reads log at DEBUG; anomalous methods/queries/statuses, one-second latency, cancellations/panics/write failures and auth mutations retain visibility and server-owned correlation. Docker interval30s/timeout3s/retries3/start-period120s/start-interval5s balances idle work and detection; supervisor child-death exit remains immediate. Docker unhealthy does not by itself restart a container.

The isolated capacity gate found a pre-existing client-directory bottleneck: repeated authorization joins per candidate row. Issue #133 records the narrow additional scope before implementation. Migration 28 evaluates the same current effective `clients.view` scopes once per statement, with no cross-request permission cache or business schema/API change. Rollback restores the old function; result/ACL equivalence, pagination and subsequent-request revocation are covered by real PostgreSQL tests. Do not weaken the unchanged two-second gate or hide failures through repeated runs.

See [[Activity Timeline and Permission Refresh]], [[Application Shell and Session Recovery]], [runtime guidance](../../docs/production-readiness.md).

Local verification: complete frontend tests/lint/typecheck/build, actual-API browser workflows, full Go race/vet/command builds, full PostgreSQL integration (including unchanged capacity gate and 28-migration rollback/reapply) and final single-container persistence/offline restore checks pass. Current-worktree candidates remain distinct from exact-commit CI publication. The mandatory Go vulnerability scan awaits CI because the managed workspace blocks the official feed. See [verification report](../../docs/refinement-verification.md); final CI/registry evidence is recorded on the issue before closure.
