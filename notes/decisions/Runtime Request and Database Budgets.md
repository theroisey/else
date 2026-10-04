---
type: decision
status: in-review
created: 2026-10-04
tags:
  - readiness
  - database
  - availability
---

# Runtime Request and Database Budgets

#109 under #32 corrects the source-reviewed gap: an HTTP socket write deadline does not cancel SQL work. Add validated HTTP_REQUEST_TIMEOUT (default 5s), readiness < request < write, preserving earlier caller deadlines. Synchronous context propagation avoids competing writers/timeout goroutines. Context-aware work honors cancellation; CPU/body readers may not. Error rendering after deadline gives fixed 503 request_timeout/no-store/correlation, preserving actual success and client cancellation.

Runtime pool remains normally ten connections and adds 5s statement, 2s lock and 10s idle-in-transaction bounds, unaffected by ambient PGOPTIONS. Migration process retains separate 30s statement/5s lock/session locking. No TLS/grant/schema/cache change. These are failure/resource ceilings, not the user's normal 1–2 second interaction target.

Real disposable SQL tests observe all bounds, explicit-transaction cancellation and recovery; implicit autocommit/network cancellation cannot establish rollback. Compiled production API locked read/write tests use real sessions/grants, require safe errors, unchanged client/audit fingerprints and later successful read/exactly-once update/audit. Refresh revision/history after uncertain mutation outcomes; no automatic write retry. Safe logs and original matrix/capacity checks remain required.

The [guide](../../docs/runtime-budgets.md) records effects and limits. Full local/final-head gates remain required before review. Argon admission, distributed edge/replica connection ceilings, background ownership, deployed telemetry/secret/backup/rollback/topology proof and complete provider readiness remain open. No production rollout authorized.

- [[Remaining Roadmap]]
- [[Implemented API Capacity Baseline]]
- [[Implemented System Threat Review]]
