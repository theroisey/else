# MCP engineering delivery report — 2026-10-17

## A. Architecture

Native `/mcp`, OAuth metadata/endpoints and browser management run inside the existing Rust/Pingora application. No second listener, runtime daemon, database, container or image is introduced. Direct reviewed adapters reuse current domain services, SQLite admission, exact financial arithmetic, safe audits, provider report cache and recovery. The baseline is `c2ef8fcbdc5527af2d1789dc207c1dec9d0195dc` on `main`. Local evidence below describes an explicitly labeled implementation worktree image, not a published commit or production deployment.

## B. Implemented capabilities

**121 tools**, one concrete resource, nine resource templates and four context prompts. The [complete tool inventory](mcp-tools.md) records every name, scope and write boundary. Families cover clients/properties, task queue and lifecycle, plans/milestones, reminders, technical request/delivery/review history, notifications, pricing/collections/payments/reversals, contractual periods/revenue splits/internal transfers, recurrence, teams/users/roles, audit and stored GA4/WooCommerce/Meta reports. Resources/prompts reuse the same permission-filtered read tools. JSON-response Streamable HTTP is implemented. Unsupported optional transports/extensions are listed under J.

## C. Authentication and authorization

Owner-controlled public-client pre-registration; Authorization Code + S256 PKCE; exact redirects, issuer/resource binding; hashed 15-minute opaque access credentials; one-use rotating refresh within a fixed 30-day grant; immediate SQLite revocation and current-user checks. Twenty-four delegated scopes and an optional brand ceiling intersect actual current permissions. Browser consent and exact-payload high-impact approval use the existing session/Origin/CSRF. Standard writes require retained command UUIDs; changes, safe audit, command receipt and any approval consumption commit together under a checked transaction proof. Restore fences all old delegation before publishing the target.

## D. Tested protocol compatibility

Both **2026-07-28 stateless discovery** and **2025-11-25 initialize** were executed with an independent official **rmcp 3.5.1 Streamable HTTP client** against native Pingora and the actual image. It independently lists all tools and exercises tool calls, resources and prompts. The Python/browser harness performs real OAuth issuance; this does not claim that the SDK client itself automates the browser OAuth handshake. No commercial-client or live Cloudflare account was available for verification.

## E. Measured performance

Image `sha256:1c13c5adb173b83778d38d18d36994bce250a8459b61e6e9c4bf0a3606170a03`, 41,045,570 bytes; read-only scratch runtime, UID/GID 65532, Rust PID 1 and one private owned Redis child. Two-CPU/256-MiB fixture. All 1,250 measured requests across 25 cases had **zero unexpected failures**. Fifty samples per case: p99 is the observed maximum. Expected authorization denials are validated successes, not hidden failures.

| Workload | Concurrency | p50 ms | p95 ms | p99 ms | Requests/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| native_rest | 1 | 1.356 | 1.604 | 1.931 | 674.93 |
| native_rest | 8 | 7.497 | 9.546 | 11.292 | 968.46 |
| mcp_discovery | 1 | 1.027 | 1.319 | 1.592 | 917.18 |
| mcp_discovery | 8 | 5.469 | 12.043 | 20.007 | 1172.86 |
| mcp_tool_listing | 1 | 4.634 | 5.230 | 5.370 | 211.07 |
| mcp_tool_listing | 8 | 38.857 | 50.998 | 63.279 | 196.47 |
| mcp_resource_listing | 1 | 0.999 | 1.174 | 1.607 | 960.78 |
| mcp_resource_listing | 8 | 4.826 | 11.933 | 14.899 | 1237.60 |
| mcp_resource_read | 1 | 1.639 | 1.945 | 2.290 | 600.41 |
| mcp_resource_read | 8 | 8.064 | 11.088 | 12.153 | 869.68 |
| mcp_client | 1 | 1.568 | 1.915 | 2.294 | 613.16 |
| mcp_client | 8 | 9.358 | 11.639 | 13.820 | 818.57 |
| mcp_tasks | 1 | 4.105 | 4.436 | 4.622 | 240.52 |
| mcp_tasks | 8 | 27.078 | 29.290 | 29.619 | 289.70 |
| mcp_search_page | 1 | 2.045 | 2.528 | 2.654 | 476.69 |
| mcp_search_page | 8 | 11.986 | 14.271 | 15.602 | 632.56 |
| mcp_scope_denial | 1 | 1.065 | 1.302 | 1.533 | 894.98 |
| mcp_scope_denial | 8 | 5.426 | 9.812 | 13.664 | 1187.52 |
| mcp_revoked_token | 1 | 0.958 | 1.306 | 1.918 | 969.79 |
| mcp_revoked_token | 8 | 4.674 | 8.888 | 12.143 | 1270.10 |
| mcp_report_cache_hit | 1 | 2.121 | 2.559 | 3.855 | 443.58 |
| mcp_report_cache_hit | 8 | 11.539 | 14.452 | 16.235 | 642.13 |
| mcp_report_cache_miss | 1 | 2.643 | 3.061 | 4.754 | 16.66 |
| mcp_task_mutation | 1 | 3.196 | 3.641 | 3.694 | 305.95 |
| mcp_task_mutation | 8 | 19.297 | 24.270 | 25.380 | 387.27 |

The native REST baseline p50 is 1.356 ms; the equivalent MCP client read is 1.568 ms (observed delta 0.212 ms). This short local comparison includes different authentication/framing and scheduling noise; it is not a universal overhead claim. Schema/descriptor and output-schema construction are process-cached, while each disclosure/query rechecks authority; only the selected descriptor page is serialized. No pre-implementation MCP benchmark exists, so no invented before/after improvement percentage is reported.

Peak Rust-process RSS observed through cumulative counters: 42,811,392 bytes (Redis excluded). Per-case CPU consumption is in the evidence JSON as process CPU seconds divided by measured wall time, with kernel clock-tick granularity. The 64-way burst accepted 32 and shed 32 requests with bounded 503 responses; no unexpected response occurred. Cold-report latency excludes owned cache eviction, while its wall throughput includes the eviction helper.

The separate **500-client/100-user** image rehearsal completed 3,000 requests and 100 writes in 9.9 seconds: read p95 461.22 ms, write p95 267.87 ms, mixed p99 573.91 ms; observed whole-container memory 26.18MiB / 256MiB. These are synthetic loopback rehearsals, not soak, internet, live-provider or production SLA evidence. See [raw aggregate evidence](performance/mcp-2026-10-17.json).

## F. Security verification

Tested OAuth PKCE/audience/expiry/replay, disabled users/apps, scope narrowing, malformed messages/header bindings, CORS/Origin denial, scoped lists/search/resources/aggregates, separate employee/developer request review, permission removal, concurrent acceptance/write replay, changed-payload conflict, queued grant revocation, exact financial approval, missing commit-proof rollback, audit failure rollback and cancellation/lost-response reconciliation. Backup/restore preserves commands and business history while rejecting old tokens even after re-enable. Browser approvals cannot be submitted by bearer actors or inspected after financial authority is lost. Current genuine Rust/npm scans found zero vulnerabilities; the two existing narrowly bound Pingora maintenance dispositions remain visible. See the [threat/authority contract](mcp.md#authorization-and-threat-boundaries).

## G. Verification evidence

Executed local results:

| Check | Result |
| --- | --- |
| Rust unit/domain/security/integration suite | 110 passed, 0 failed |
| Rust format / all-target Clippy | Passed, warnings denied |
| Frontend unit/flow suite and asset-worker tests | 478 passed across 51 files; 5 service-worker tests passed (isolated full rerun) |
| Frontend lint / TypeScript / production bundle budgets | Passed; initial gzip JS 192,169 bytes / 7 requests |
| Browser image regression | 34 existing scenarios passed; corrected paginated MCP scenario passed its focused rerun with 26 unrelated brands |
| Official SDK interoperability | Both protocol eras passed against native Pingora and the actual image |
| Image startup / persistence / online backup / fresh-key restore | Passed |
| Capacity / actual Compose / owned-cache failure and restart | Passed |
| Publication regression / advisory gate regression | 11 / 10 passed |
| Real npm / Rust / independent-client dependency scans | 0 vulnerabilities; existing reviewed Pingora maintenance findings remain visible |
| Workflow syntax (pinned actionlint) | Passed |

The initial full browser MCP case assumed its brand was on the first page; it was corrected to use the real search and its independent fixture now exceeds one page. No remaining product defect was inferred from that test assumption. No live deployment, Cloudflare configuration, commercial-client account or live-provider credentials were tested.

Reproduction commands:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
(cd frontend && npm run lint && npm run typecheck && npm test && npm run build)
make mcp-client
python3 tools/test-mcp.py --binary build/roisey-else
python3 tools/test-mcp.py --image else-application:ci --benchmark-output /tmp/mcp.json
python3 tools/test-browser.py --no-build --image else-application:ci
python3 tools/test-startup.py
python3 tools/test-container.py
python3 tools/test-capacity.py
python3 tools/test-compose.py
python3 tools/test-publication.py
python3 tools/check-workflow.py
python3 tools/test-rust-advisories.py
python3 tools/check-rust-advisories.py
python3 tools/check-rust-advisories.py --mcp-client
```

An early full browser run exposed the unregistered frontend `mcp.manage` catalog key; the catalog now recognizes only its global scope and the administration regression checks cover it. The new browser fixture was also corrected to use the paginated authorized brand search; its focused rerun seeds more than one page. Two timezone subprocess cases initially received sandbox EPERM; both passed with the required execution permission. Two one-second frontend waits also failed during simultaneous Rust load; the complete isolated frontend rerun passed without changing timeouts. Failures were not suppressed or converted into passes. Screenshots and browser credentials are not retained in traces/video. The MCP visual matrix covers five locales, both themes, 360/390/430/1280/1440/1920 widths; screenshots settle finite transitions before capture.

## H. Deployment and operations

No production deployment or production migration was performed. Ship the normal single image after all six CI jobs and exact-image promotion pass. Take a verified checkpoint before applying additive migration `000008_mcp_bridge.sql`; old migrations/history are preserved. A rollback requires schema-8-compatible code or empty-target supported recovery with reconciliation. MCP starts disabled. Configure exact external `AUTH_PUBLIC_ORIGIN`, enable in Settings and register real client callbacks; each user then consents. No new secret/provider/daemon is required. Forward Host/Authorization/MCP headers, bypass caching only on machine OAuth/MCP metadata paths, and narrowly exempt demonstrated Cloudflare challenges while preserving Else authentication/WAF. [Detailed setup and diagnostics](mcp.md#https-ingress-and-cloudflare).

## I. Changed files

- `backend/src/mcp/`: access, OAuth, transport/protocol, static registry, direct adapters, resources/prompts, exact commands/approval, analytics projection, metrics/management and security/integration tests.
- Existing backend actor/domain checks now honor delegated ceilings; the database adds request-local commit proof; safe audit source and supported recovery include MCP. DTOs expose generated input schemas without replacing native financial/lifecycle rules.
- `backend/migrations/sqlite/000008_mcp_bridge.sql`, Cargo lock/dependencies and the dev-only runtime inspection helper. No Dockerfile/Compose production topology change.
- React Settings/guide/consent/approval/metrics; narrow safe login return paths, global permission catalog, audit source and five localized MCP catalogs. Existing themes/icons/mobile/navigation remain.
- Independent pinned upstream client, native/image benchmark and browser tests; Make/CI/advisory scanning. All six required CI names and exact tested-image publication stay intact.
- README, architecture/operations/frontend notes, contracts/tool inventory and measured evidence.

## J. Remaining limits

Public-client **pre-registration** is required; DCR/CIMD and arbitrary metadata fetching are deliberately absent. JSON responses only: SSE subscriptions, resumability, stdio, MRTR and WebSockets are not implemented/advertised. Private binary evidence uploads and provider credential configuration remain in the browser; reports use configured stored observations. No external LLM, external authorization or production provider credentials were invented. Human approval is by the delegating user, not an independent second owner. In-memory metrics reset on restart. The existing single-process SQLite-volume architecture remains; this is not horizontal SQLite replication. Live ingress/client-account behavior, production enablement, deployment, long soaks and operating recovery objectives require operator configuration/verification. Native workflow, permission and finance checks remain authoritative.
