# Native MCP bridge

Roisey Else exposes reviewed domain operations at `/mcp` on its existing Pingora listener. It starts **disabled**. This is part of the existing application, database, background workers and single scratch image; it adds no listener, daemon, external authorization service or customer-data store. See [verification evidence](mcp-delivery.md).

## Enable and connect

1. Configure `AUTH_PUBLIC_ORIGIN` as the exact external HTTPS origin, such as `https://else.example.com`. Existing storage, keyring and ingress requirements remain unchanged. No new secret or environment variable is required.
2. In **Settings → AI connections**, a user with global `mcp.manage` enables MCP and registers an application. Supply the **exact callback URLs provided by the client**. The returned application UUID is its OAuth `client_id`. Registration accepts up to eight HTTPS callbacks (HTTP loopback for local clients) and four exact browser origins. No wildcard, userinfo, fragments or reserved OAuth response query fields are accepted.
3. Configure the client for remote Streamable HTTP at `https://else.example.com/mcp`, with the registered public client ID. Some clients accept the example below; configuration syntax varies. The client must support owner-controlled pre-registration and Authorization Code/S256 PKCE. A client that requires dynamic registration or Client ID Metadata Documents cannot connect automatically to this version.
4. Follow the client's sign-in flow. Else preserves the consent destination through login. Choose delegated capabilities and, optionally, one brand. Requested capabilities are restricted to current user authority. Declining grants nothing. No client secret or personal access token is required.
5. Review active grants in Settings; revoke your own grant at any time. Administrators can revoke an application or disable MCP (revokes all current grants). Re-enabling does not resurrect them.

```json
{"mcpServers":{"roisey-else":{"url":"https://else.example.com/mcp"}}}
```

This example contains no token. Never put browser cookies, OAuth codes, access tokens or refresh tokens in a configuration screenshot, URL, issue or prompt. A production client must store credentials in its protected credential store. Application registration is not user authorization.

Public metadata: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`. OAuth routes: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`. Authorization and token requests require the exact `/mcp` resource indicator. Token/revocation use form encoding. Browser consent/approval and management use the existing session, exact Origin and CSRF protections under `/api/v1/mcp`; bearer credentials never substitute for them.

## Protocol contracts

The adapter uses pinned official `rmcp` 3.5.1 model types and `oauth2` 5.0.0 PKCE primitives. It supports these separate paths:

| Contract | Behavior |
| --- | --- |
| 2026-07-28 | Stateless `server/discover`; mandatory protocol/client-capabilities request metadata; matching `MCP-Protocol-Version`, `Mcp-Method` and applicable `Mcp-Name`; typed complete results; private discovery freshness `ttlMs: 0` |
| 2025-11-25 | `initialize`, `notifications/initialized`, subsequent requests with the negotiated version; no invented session requirement; no modern-only result/cache fields |
| HTTP | POST JSON, client Accept includes `application/json` and `text/event-stream`; server returns JSON only; notifications return 202; GET/DELETE return 405 |
| Unsupported | No SSE streams, subscriptions, resumability, stdio endpoint, MRTR, outbound MCP execution, dynamic registration, CIMD, WebSocket or transport session |

Single request envelopes only: no JSON-RPC batches. Duplicate JSON keys, excessive nesting, unsafe request IDs, invalid metadata, header/body mismatches and unsupported versions fail explicitly. `Mcp-Name` sentinel encoding follows the current transport contract. Unknown modern methods return 404/-32601. Tool-domain failures have `isError` and structured error/retry information; protocol failures remain JSON-RPC errors. Responses retain a safe request correlation ID. Every route returns private/no-store headers. The public asset-only service worker bypasses these paths.

## Capability inventory

There are **125 statically reviewed tools** ([complete inventory](mcp-tools.md)). Names, input/output JSON schemas, risk, required scopes, permission hints, side effects and retry guidance are discoverable. The registry is compiled once; authorization is recalculated for each request and disclosure is paged (24 descriptors). No REST loopback or generic database dispatcher is used.

| Tool family | Native behavior reused |
| --- | --- |
| `else_clients_*`, `else_websites_*` | Profiles, contacts/tags, overview, independent properties, revisioned updates and archival |
| `else_tasks_*` | Shared queue, bounded lists, assignee eligibility, create/update/assignment/status/archive |
| `else_plans_*`, `else_milestones_*` | Plans, milestones, retained task links and valid lifecycle changes |
| `else_reminders_*` | Explicit wall-clock/zone/offset scheduling, completion and dismissal |
| `else_requests_*` | Create/read/decision/assign/start/deliver/review/revision/reopen/cancel/comment plus versioned delivery/timeline history |
| `else_collections_*`, `else_finance_*` | Receivables, exact currency-separated totals, partial payments, cancellations and retained reversals |
| `else_pricing_*` | Read/version history, exact preview, approved create/append, immutable snapshot/copy to a collection |
| `else_agreements_*`, `else_periods_*` | Versioned terms, bounded period generation, collector/split policy, payments and internal settlement/voiding |
| `else_recurring_*` | Templates/versions/occurrences and the existing bounded idempotent generation engine |
| `else_teams_*`, `else_users_*`, `else_roles_*` | Team and assignment history; safe user reads/updates/disable; approved role/permission/grant changes |
| `else_analytics_*` | Authorized connection metadata and bounded projections of stored GA4, WooCommerce and Meta Ads reports |
| `else_audit_*`, `else_notifications_*`, `else_identity`, `else_today` | Safe audit projections, current per-user notifications, delegated identity and scoped daily work |

No password/account-creation, provider credential, encryption/key, recovery/deployment, arbitrary URL fetch, shell/SQL/file, bulk destructive or raw upload capability is exposed. Evidence metadata stays in native request projections; private binary uploads/downloads remain in the authenticated browser. Native domain parent checks and review separation remain authoritative. A developer cannot self-approve a delivery. Monetary values stay canonical strings, exact arithmetic and separate currencies. A consulting share remains inside the customer fee, never a second charge. Reports are stored observations, never synchronous provider calls; missing/stale/null values are not invented zeros. Summary responses omit row arrays; provider-specific sections page up to 50 rows. WooCommerce requires currency; other providers reject a currency argument rather than pretending to filter it.

One concrete resource (`else://identity`), nine templates (brand dossier/overview, task, plan, reminder, request, finance, agreement, billing period) and four context prompts (`client_brief`, `daily_priorities`, `request_review`, `finance_reconciliation`) reuse these read-only tools. Resource URIs cannot access files or trigger network fetches. Business text is explicitly untrusted context; prompts make no backend LLM call and grant no authority.

## Authorization and threat boundaries

Access tokens are opaque random 256-bit values, stored as hashes, valid for 15 minutes. Refresh credentials rotate once per use within a fixed 30-day grant deadline. Authorization codes last two minutes, require S256 and consume once; consent requests expire after ten minutes. Code/refresh replay revokes the grant, including its access tokens. Resource audience, application, user, scope ceiling, optional brand, active state and current grants are rechecked against SQLite. Redis never stores authority. Scope narrowing cannot grant latent permissions. Client-specific access cannot grant global administration.

The effective boundary is **current actual user permission ∩ delegated scope ∩ optional brand**. Reads, searches, dashboards, resources, prompts, notification destinations and writes all honor it. Ordinary REST sessions keep their existing behavior. Writes recheck inside the admitted IMMEDIATE transaction; queued revocation is effective before the business write. Query parameters, role names, creator identities, forwarded headers and knowledge of UUIDs confer no authority.

Host must match the explicitly configured public origin. Browser Origin must be same-origin or an exact registered origin for that application. No wildcard CORS, cookies fallback, token query parameter or arbitrary metadata fetch. Cross-origin token/revoke calls must identify the matching registered application. Public metadata exposes no credentials. Clients without an Origin remain authenticated machine clients, not exempt callers. Limits apply before body ingestion; errors do not disclose private query text or raw database/provider failures.

Threat verification covers IDOR/client ceilings, scope and authority revocation, unsafe redirects/PKCE/resource mismatch, expiry/replay, cross-origin mismatches, malformed inputs, concurrent commands, audit atomicity, cancellation and recovery fencing. Prompt injection cannot invoke tools without the same server checks. Human approval protects high-impact operations; it is **approval by the delegating user**, not an independent two-owner authorization system. The trusted host/operator can defeat filesystem/database protections.

## Commands and browser approval

Every write requires a retained command UUID. Keep the same tool, exact payload and expected revision on retry. The digest binds user, application and command; changed payloads conflict. A successful receipt identifies the affected resource and original request. A lost response does not prove rollback. Revoking delegation does not undo committed work or cancel an existing agreement/template; pause or cancel those explicitly under the native permissions. Native idempotent replays can return `reconciled` with the retained domain record.

Financial changes, archives and privileged administration additionally return `approval_required` with a short-lived browser `review_path`. The user opens that path, sees the exact protected arguments/digest and approves or denies using the existing session/CSRF controls. Approval does **not** execute anything. Repeat the same command with the returned `approval_id` before expiry. Bearer clients cannot approve; a supplied `confirmed` flag has no effect. Permission loss also hides an old financial review payload.

The actual domain mutation, typed safe audit, one-use approval consumption and durable command receipt commit together. The database's existing transaction token distinguishes retries from sibling audits within a multi-record mutation. A request-local database guard rolls back changed SQL unless the exact command receipt and audit exist in that transaction. A mistaken registry primary kind therefore cannot bypass approval or commit without reconciliation evidence. Blocking work retains its admission permit after caller cancellation.

## Limits, metrics and retention

| Budget | Value |
| --- | --- |
| MCP work admission | 12 concurrent requests, immediate 503 when full |
| Body / headers / response | 64 KiB / 16 KiB / 512 KiB |
| Domain page / tool-discovery page | Up to 50 / 24 |
| Per-direct-peer rate | 2,400 MCP and 60 OAuth requests/minute; bounded 4,096-entry process map |
| Applications / callbacks / origins | 64 active / 8 per app / 4 per app |
| Pending consent / private approvals | 1,024 global / 64 active pending per user |
| Intent TTL / payload | 10 minutes / 48 KiB |

Existing global HTTP deadlines, database admission/writer limits, bounded cache and provider workers remain. Limits are per process; a shared ingress can legitimately share a peer rate budget because forwarded identity is intentionally untrusted. Set edge admission accordingly rather than trusting arbitrary X-Forwarded-For.

Owner-authorized `/api/v1/mcp/metrics` and the management UI expose bounded process request/tool counters, failure counts, active work and fixed latency buckets. No per-user labels, tokens, arguments or customer identifiers. Restart resets these diagnostic counters; durable audits/receipts remain. Discovery caches only compiled schemas, not permission results.

Issuance performs bounded GC (128 rows per class): expired access tokens, expired refresh generations, codes after grant expiry, expired consent without a retained code, and private approvals 30 days after expiry. OAuth state clears on consent consumption. Commands, audits, financial/business history and evidence remain retained. No automatic cleanup deletes customer records.

## Migration, backup and rollback

`000008_mcp_bridge.sql` adds 11 STRICT tables and relevant indexes/immutability guards; existing migrations 1–7 are unchanged. The administrator receives the new global `mcp.manage` key through existing permission initialization; custom grants are not broadened. MCP is disabled by default. Supported backup includes all MCP tables.

Supported empty-target restore disables MCP, revokes all prior grants, consumes outstanding authorizations and revokes pending approvals before publishing the restored database. Even manual re-enable cannot reactivate an old bearer credential. Command receipts and original business history survive. Take a verified backup before upgrade; rollback needs a schema-8-compatible artifact or rehearsed empty-target restore and post-checkpoint reconciliation. There is no destructive downgrade or production migration performed by this assignment.

## HTTPS ingress and Cloudflare

Keep TLS termination in the existing host ingress. Forward the exact external Host configured by `AUTH_PUBLIC_ORIGIN`; preserve Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Origin and request bodies. Do not rewrite `/mcp` to `/app` or redirect it to login. No WebSocket upgrade, buffering exception or long SSE timeout is needed. Allow a little more than the application's five-second handler ceiling, without adding unbounded retries. Never automatically retry a write with a new command ID.

Bypass edge caching **only** for `/mcp`, `/oauth/*` and `/.well-known/oauth-*`; honor origin no-store. If Cloudflare challenges verified machine clients, scope a Skip rule to this exact hostname and these paths, with the required methods, skipping only the demonstrated blocking challenge feature. Keep authentication, WAF protections and rate limiting. Do not globally disable Bot Management/security or make `/api/v1` public. Client errors should be JSON, not a 200 HTML challenge. Never log Authorization or token/code request bodies.

| Symptom | Diagnose |
| --- | --- |
| HTML/Cloudflare 403 | Inspect edge request/rule logs using the safe correlation context; narrow the blocking rule |
| 401 + WWW-Authenticate | Missing/expired/revoked bearer or wrong resource; reauthorize/refresh safely |
| 403 + insufficient_scope | Request the required delegated capability, within current authority |
| 403 Origin denial | Check the exact registered browser origin and configured Host |
| Tool `isError`, permission/not-found code | Current domain permission, parent, lifecycle or revision denied the operation; inspect current grants without guessing another ID |
| 400 header mismatch / unsupported version | Match the advertised protocol, method/name and request metadata |
| 405 | Use POST; no standalone SSE GET or transport-session deletion |
| 409 command/revision conflict | Reconcile original command/record; never silently overwrite or guess |
| 413 | Narrow requested section/page; response/body budget is enforced |
| 429 / 503 | Respect Retry-After/admission; preserve write command identity |

Cloudflare live configuration and commercial-client account behavior require operator verification. Local/native/actual-image evidence is not proof of a production rollout.

## Reproduce verification

`make check` keeps the normal gates. `make test-mcp` also builds the independent, host-only upstream SDK HTTP client. `tools/test-mcp.py` issues real OAuth credentials against owned disposable storage, runs **both** upstream SDK lifecycle modes, checks scopes/IDOR/replay/retained writes and can write a bounded workload report:

```sh
python3 tools/test-mcp.py --binary build/roisey-else
python3 tools/test-mcp.py --image else-application:ci --benchmark-output /tmp/mcp.json
python3 tools/test-browser.py --no-build --grep 'MCP consent'
```

The image benchmark additionally needs the existing host `browser-fixture` and static `build/runtime-fixture` helpers; neither is shipped. It explicitly seeds a synthetic completed provider report without credentials or external jobs. Fifty samples per case report p50/p95/p99, throughput, cumulative Rust-process CPU/peak RSS (Redis excluded) and errors at concurrency 1/8 plus an overload burst. The 500-client/100-user capacity, native HTTP, actual-image recovery and Compose checks remain separate. Short loopback results are not an SLA, soak test or live-provider measurement. CI retains all six required jobs and promotes the same checked image, not a rebuild.

Financial intelligence adds four read-only operations: `else_financial_dashboard`, `else_financial_receivables`, `else_financial_payments` and `else_financial_clients`. All use finance:read, current underlying client/billing permissions and the optional delegated brand ceiling; a company-wide view additionally requires finance.read_company. They do not grant cost visibility or financial writes. Brand-scoped grants exclude internal company expenses. See [metric definitions](financial-intelligence.md).
