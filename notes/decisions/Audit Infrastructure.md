---
type: decision
status: pr-review
created: 2026-10-01
tags:
  - audit
  - database
  - security
---

# Audit Infrastructure

Issue #7's policy was recorded before implementation. The audit package owns the pgx transaction and requires one typed successful event before commit; business and audit failures roll back together. A limited query capability keeps lifecycle ownership in the helper. Trusted SQL and domain authorization remain review responsibilities, not an SQL sandbox.

Shared server-generated correlation moves from HTTP-only context into internal/correlation. Incoming headers never choose persisted IDs. Explicit system actors serve trusted internal operations before authentication; verified user actors arrive with #8. No public mutation/read API, domain module or user activity is added.

Snapshots initially allow only existence and revision markers; metadata only a source enum. Domain slices must extend typed fields and database allowlists deliberately. This avoids storing whole DTOs/secrets without inventing future domain state. SQL bounds and shape checks reinforce the application contract.

Audit INSERT is column-scoped, with no runtime SELECT/update/delete/truncate or owner privileges. An ALWAYS trigger rejects destructive DML even if grants broaden. Runtime executes only the immutable snapshot validator. Administrators/migration owners remain trusted; this is not cryptographic tamper-proof storage.

Audit rollback locks and refuses nonempty history. No automatic deletion/retention; privileged retention policy needs a separate Issue. Empty full migration roundtrips remain reversible. Future identity/client FKs and read authorization belong to their own Issues.

Go formatting/vet/race/static builds and tagged-suite compilation pass locally. All four actual gates pass in CI run 36858914108 for cea4720d25d096c489326035b950e1e1a1bfec24, including PostgreSQL rollback/permissions/correlation and Compose runtime/migrations. Publication is correctly skipped on the PR. Docker Hub's unauthenticated pull limit still blocks local container execution; GitHub supplied runtime evidence. PR #41 awaits owner review/merge.

- [Issue #7](https://github.com/theroisey/else/issues/7)
- [Audit contract](../../docs/audit-log.md)
- [[PostgreSQL Foundation]]
- [[CI and Publication]]

- [PR #41](https://github.com/theroisey/else/pull/41)
- [Verified implementation CI](https://github.com/theroisey/else/actions/runs/36858914108)
