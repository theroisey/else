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

That historical read baseline is a short API burst on one process/local database. The final mixed extension below additionally exercises writes, stored provider reports, two API replicas and independent worker admission. Both measure complete HTTP body receipt, not browser render/edge latency or sustained production throughput. The client and database share runner resources; production telemetry/edge/vendor latency may add cost. No index or cache is introduced without measured need.

## Final mixed workload under #31

The same fixture now continues after proving all original reads left domain/audit/session state unchanged. It grants analytics read access to the same 100 sessions and task write access to ten. It seeds **1,500 strictly normalized synthetic GA4/WooCommerce/Meta reports**, one of each per measured client, in the disposable owner transaction, with normal constraints and exact large-number/decimal values. Real API report reads validate their public contract and must return the complete exact seeded projection, current successful status and immutable client/connection/period binding.

Two actual compiled API processes use their unchanged ten-connection pools against that same database. All sessions alternate between processes without affinity. One hundred synchronized users each issue thirty requests: **2,970 reads and 30 audited task creates (1%)**. The eleven route families cover both directories, overview, tasks, reminders, collections, pricing, all three provider reports and task creation. Successful task mutations must have unique IDs/revision1, exact persisted actor/client/content and exactly one corresponding bound audit. Other domain/history/session counts and complete provider snapshot fingerprints must remain unchanged.

Encrypted real provider setup queues three jobs using synthetic credentials. Two separate real audited claims hold current live leases to represent bounded external collection; neither holds an open database transaction. Two actual worker objects, each using its own production-configured two-connection pool, repeatedly exercise the shared claim logic while the third provider remains queued. They must observe no available work, no error and no third admitted job. Current leases/snapshots must remain stable and no idle transaction may remain. This measures user-facing behavior during **synthetically held background work**, not vendor network throughput, success or ownership. Adapter contract, network/fence/cancellation and lifecycle tests separately cover actual implemented collection boundaries.

The final local run passes all **4,700 staged requests**, including original20/50/100 stages and the3,000-request mixed phase. It uses Go1.27.1, PostgreSQL18.3 and GOMAXPROCS3. Mixed phase13.0s,230.82 requests/s, zero invalid responses/timeouts,30 writes/audits and85 worker polls. The complete extended fixture finishes45.74s (race suite reports46.781s). Fixed2s route P95 and3s client limits are unchanged.

| Mixed family | Requests | P95 ms | Maximum ms |
| --- | ---: | ---: | ---: |
| Directory,25 rows | 297 | 193 | 433 |
| Directory,100 rows | 297 | 1,334 | 1,797 |
| Overview | 297 | 269 | 676 |
| Tasks | 297 | 937 | 1,071 |
| Reminders | 297 | 151 | 507 |
| Collections | 297 | 908 | 1,103 |
| Pricing | 297 | 195 | 495 |
| GA4 | 297 | 926 | 1,000 |
| WooCommerce | 297 | 167 | 731 |
| Meta | 297 | 912 | 969 |
| Task create | 30 | 907 | 933 |

Real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` observes representative bounded retrieval primitives without forcing index scans or logging statements/arguments. Task pages use `tasks_active_client_id` (25 rows,28 hit blocks,0.102ms execution); overview task/reminder queues use `tasks_open_due` / `reminders_pending_due` (6 rows,9/8 hit blocks,0.029/0.038ms); exact provider snapshots use `analytics_snapshot_period` (1 row,6 hit blocks,0.021ms). Those local warm plans justify retaining current indexes. They are not plans for every statement inside SECURITY DEFINER functions or for unmeasured multi-year report cardinality. Existing overview index-eligibility tests and one-aggregate-statement tests remain active.

## Critical flow and interaction evidence

All18 actual Go/API/disposable PostgreSQL browser flows pass: login/session expiry/current grant revocation; users/roles; clients; tasks; planning; timezone reminders; activity/audit; immutable pricing; exact finance and lost-response recovery; one-request overview; GA4, WooCommerce and Meta pending encrypted-setup refusal/stored-report access; release metadata; and local disconnect/fresh scope. The secured production build also passes CSP/frame attack checks. Recorded keyboard flows exercise navigation, forms and modal focus/escape/return; desktop/mobile overflow assertions and visibly synthetic screenshots cover operational and provider workspaces. This is functional responsive/keyboard evidence, not a complete assistive-technology accessibility certification.

Existing real-browser request counters verify a single overview aggregate request, bounded catalog/detail reads, absence of hidden denied domain reads, and no automatic replay of uncertain financial/pricing/integration writes. The complete PostgreSQL race suite passes in523.670s before the final mixed-test addition; the new final test then passes separately in46.781s. Ordinary Go race/vet,518 frontend checks and the single application image/runtime rehearsal pass locally. Final main CI must run the combined source. [Production operating procedures](production-readiness.md) distinguish these reproducible synthetic results from target pooling/edge/logging/backup/rollback acceptance and explicit traffic approval. No live provider credential, deployed SLA or sustained-arrival/soak guarantee is inferred.
