# Request and PostgreSQL resource budgets

[#109](https://github.com/theroisey/else/issues/109) addresses the implemented-source cancellation gap under [#32](https://github.com/theroisey/else/issues/32). HTTP socket write deadlines alone do not bound database work. These limits protect availability for the user's 500-client/100-user readiness assumptions; ordinary interactions still target 1–2 seconds. A five-second failure ceiling is not a performance target or a deployment SLA.

## Applied bounds

| Work | Bound | Effect |
| --- | --- | --- |
| Synchronous handler context | `HTTP_REQUEST_TIMEOUT`, default 5s | Context-aware query/acquisition/transaction work receives a deadline; an earlier caller deadline is preserved |
| PostgreSQL runtime statement | 5s | Server-side statement cancellation even when the caller does not promptly observe it |
| PostgreSQL runtime lock wait | 2s | Abort a blocked statement rather than wait indefinitely |
| PostgreSQL idle runtime transaction | 10s | Terminate the idle session and roll back its transaction |
| Migration statement / lock | Existing 30s / 5s | Separate one-connection migration process retains its own bounds/session locking |

HTTP configuration rejects nonpositive/invalid/excessive durations and requires readiness < request < write timeout. The normal ten-connection pool, zero minimum, 30-minute connection lifetime, five-minute idle lifetime, TLS verification, role grants and schema remain unchanged. Pool configuration overwrites ambient PostgreSQL session options. API/readiness/transaction contexts and independent server budgets address different failure paths; cancellation of the caller does not prove that every server operation stopped at precisely that instant.

The middleware runs synchronously and does not introduce a timeout goroutine, buffered response or competing writer. Error responses rendered after a deadline use HTTP 503, `request_timeout`, fixed safe text `The request timed out. Refresh before retrying.`, normal server-owned correlation and JSON/no-store headers. Actual successful commits/responses retain their result; client cancellation is not reclassified as this deadline error. Independent server lock/statement errors retain existing safe domain error handling. No SQL, credentials, payloads or raw provider/server details enter responses/logs.

Context deadlines cannot preempt arbitrary CPU work or body readers that ignore context. Existing socket read/header/write/idle bounds still apply; concurrent Argon2 admission, distributed edge limits, background-job ownership and deployed gateway/database connection ceilings remain separate readiness work. Increasing HTTP_REQUEST_TIMEOUT cannot disable the independent runtime SQL bounds. Pool/query metrics and log-sink overhead still need deployed assessment. Background integrations must use bounded independent work rather than extend a user request.

## Mutation and recovery semantics

Audited business writes already use explicit transactions and bounded cleanup. Canceling a blocked precommit write must leave neither a domain change nor a successful audit. A canceled connection or lost commit response can nevertheless leave the client uncertain about an operation's outcome; implicit autocommit cancellation is particularly not rollback proof. Refresh current revision/history before retrying and never automatically retry a timed-out mutation. These tests cover blocked precommit rollback, not every possible network loss around commit.

Disposable PostgreSQL tests observe actual session settings, server statement/lock/idle-transaction timeout classifications, earlier context cancellation inside an explicit transaction, unchanged probe data and one-slot pool recovery. They separately confirm actual migration settings remain 30s/5s/default idle. A compiled production API test uses actual migrations/runtime grants and real admin session, holds private table/row locks, and requires safe 503 read/mutation responses before the SQL lock budget. Client/audit fingerprints remain unchanged after timeout; subsequent reads and exactly one successful update/audit prove recovery. Logs must omit synthetic payload/session/CSRF/password values.

Unit checks cover safe configuration, earlier deadlines, fixed correlation/no-store errors, successful responses and client cancellation. Existing compiled authorization/CSRF/isolation matrix and 500-client capacity budgets remain intact. Relevant local and all six exact-head checks are required before ready; actual results belong in #109/its PR/#32. No deployment or final #32 acceptance is inferred from test code.
