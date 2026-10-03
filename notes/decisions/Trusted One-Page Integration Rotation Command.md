---
type: decision
status: owner-merged
created: 2026-10-03
tags:
  - integrations
  - backend
  - security
  - operations
---

# Trusted One-Page Integration Rotation Command

Owner merged PR #89 at `1572cc33f201ecf2f6776ef6bb3eada4b4913211`. Final-head CI 37137926217 and main CI 37139320933 passed all five verification gates; both development branches synchronized before #90. The following records the original mutating command policy. [[Live Integration Key Retention Inventory]] adds a separate explicit read-only mode without changing mutation confirmation.

Issue #88 records trust, confirmation, output-loss and restore policy before code. It follows owner-merged CI recovery #86 / PR #87 at `e32f033`; final-head run 37132339515 and main run 37135941841 passed all five verification gates. Both development branches synchronized. Parent #24 stays open.

The command is a trusted operator transport for protected loading, declared-mode preflight and bounded rotation. Runtime database/key access is privileged writer authority; actor UUID is checked audit attribution, not end-user authentication. Externally authorized operators must never expose this entrypoint to untrusted actors/public jobs. No schema, permissions, events, HTTP/frontend surface, provider traffic or default Compose service is added.

Strict flags require confirmation, canonical UUIDs and page size 1–100 before configuration access. Sole help is safe. Mandatory protected Linux source and runtime DATABASE_URL precede exactly one correlated page under a 45-second operation context; thirty-second page and cleanup bounds remain. No retry, loop, cursor persistence or automatic mode change occurs.

Bounded JSON reports contain safe IDs, correlation, known commits/cursor/pending row and page/lookahead flags only. Startup/panic/output failures have fixed diagnostics and nonzero exits. Output loss can follow committed mutations: reconcile authoritative storage/audits before another explicit request. Grants apply even to empty scans. Completion proves neither retirement nor provider health.

Fresh restored material can register through the first audited reservation even if the credential write fails. Later restored invocations reject that registered active key. Operators must verify durable outcome and declared recovery transition, exclude stale writers and explicitly configure normal. Disabled/obsolete/other-client and backup ciphertext still need keys; undeclared rewind detection remains incomplete.

The separate scratch/non-root Docker rotation target keeps execution out of API/default startup and current registry publication. Real disposable database tests exercise the same orchestration; container CI executes actual help/confirmation/protected-source diagnostics. All five exact-head gates and owner review remain required. No real keys or production execution.

See [operator procedure](../../docs/integration-rotation-command.md), [[Bounded Integration Credential Rewrap Batches]], [[Protected Integration Key Startup and Declared Restores]] and [[CI and Publication]].
