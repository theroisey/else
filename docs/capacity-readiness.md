# Implemented API read capacity

[#105](https://github.com/theroisey/else/issues/105) supplies a measured slice of [#31](https://github.com/theroisey/else/issues/31), using the user's explicit readiness assumptions: 50–100 initial clients, comfortable 500+ client growth, 20–50 initial users and readiness for 100 concurrent users. Dashboard/CRUD interactions should normally feel within 1–2 seconds; background work must not block them. Vercel or similar managed hosting plus PostgreSQL is proposed. The required Go API needs a compatible runtime; [#32](https://github.com/theroisey/else/issues/32) must assess the complete same-origin/TLS/secret/database topology before rollout.

## Repeatable measured workload

`TestCapacityCompiledAPIRepresentativeReads` compiles the actual production Go API before creating its own uniquely named database/roles, applies actual migrations/runtime grants, and starts it on a private random loopback address. One hundred independently created/authenticated read-only users supply real current sessions. The API uses its unchanged default **ten-connection pool**. There is no mock handler, external database, customer dump, provider-success fixture or tuned production code.

The 500 measured synthetic clients plus two existing base fixture clients contain:

| Per measured client | Total |
| --- | --- |
| 100 overdue open tasks | 50,000 |
| 40 due reminders | 20,000 |
| 20 unpaid USD collections | 10,000 |
| 10 pricing sheets, each with one valid exact-price version/line | 5,000 sheets, versions and lines each |

The owner seeds only disposable fixtures in one transaction with all normal constraints/triggers active. Exact counts/revision sums are asserted, and ANALYZE supplies representative planner statistics. Payment history, mixed-currency cardinality, many-version pricing and populated activity-history scaling are not measured by this dataset. Existing domain/race/privilege/audit tests retain their broader correctness coverage.

Seven families are measured independently: default 25-row client directory; maximum 100-row directory; client overview; tasks; reminders; collections; and pricing. Ordinary domain pages request 25 rows; terminal collection/pricing pages correctly contain 20/10 records with no next cursor. Other seeded lists have the expected continuation. Every response must be 200, bounded to 64 KiB, JSON/no-store, match cardinality/cursor/client binding, and contain unique IDs. Overview additionally verifies exact USD balances and bounded due-work queues; an accidentally empty/denied dashboard cannot pass as fast.

After seven separately recorded cold reads and thirty warm reads, synchronized stages run **20, 50 and 100 concurrent workers**, each with its own session and ten sequential mixed requests. The stages contain exactly 200/500/1,000 observations; no think time or retry hides backpressure. Report completed-response P50/P95/P99/max, request counts, failures/timeouts, elapsed duration and throughput. All seven per-route P95 values must stay within the fixed **2-second API screening budget** and every response must be valid. A three-second client timeout is a failed observation, never a discarded sample. The two-second ceiling derives from the user's interaction target but does not allocate frontend/network headroom or establish a deployed interaction SLA.

The larger fixture has a fixed three-minute lifetime; existing fixtures retain their thirty-second limits. API compilation retains a separate two-minute bound and happens before fixture creation. Shared compiled-process setup preserves the existing security denial matrix, actual grant source, safe startup diagnostics and process joining before inspecting logs. Domain counts/revision sums and history/audit/session counts remain unchanged around measured reads. Captured API output must exclude all session/CSRF values and database passwords. No response body, account identifier, token or credential is printed in capacity reports.

## Run and interpret

Use the pinned Go 1.27.1 toolchain, Docker and `sh backend/scripts/test-integration.sh` from the repository. The disposable PostgreSQL runner retains verbose output so successful capacity metrics are visible in CI alongside all existing database tests. The focused test can also run against an explicitly provisioned disposable database with `go test -race -tags integration -count=1 -v -run '^Test(CapacityCompiledAPIRepresentativeReads|SecurityCompiledAPIDenialMatrix)$' ./tests/integration`. Never pass a production or shared database URL.

Record actual local/final-head results in #105/its PR/#31, including hardware/runtime constraints; CI results remain required before ready. The strengthened local normal/maximum-page workload passed with Go 1.27.1, PostgreSQL 18.3, GOMAXPROCS 3 and the default ten-connection pool. Worst per-route P95 at 20/50/100 workers was 260/428/595 ms, respectively; all 1,700 staged responses were valid with no timeouts. The 100-worker stage completed at 262 requests/second; its maximum observed response was 967 ms. These are local observations, not production capacity guarantees. The same focused run passed the compiled security matrix. The complete database regression passed in 289 seconds before the final pagination expansion; the expanded test and shared matrix then passed together in 26 seconds. Exact final-head CI must run the complete final suite. Initial five-row smoke measurements are superseded by this ordinary/maximum-page evidence.

This is a short closed-loop API read burst on one process/local database, with test client and database sharing runner resources. It measures complete HTTP body receipt, not browser render/edge latency, sustained arrival-rate/soak throughput, concurrent writes, distributed limits, multi-instance database connections or background jobs. Ordinary API logging is captured locally; production telemetry sinks may add cost. Future provider transport/ingestion/authorization/retention under #25–#27, complete user flows and representative mixed-write/request-count/accessibility/query-plan evidence under #31, and deployed pooling/caching/TLS/backup/rollback/monitoring under #32 remain open. Background synchronization must use bounded independent work and must be assessed against user-facing capacity before activation. No index or cache is introduced without measured need.
