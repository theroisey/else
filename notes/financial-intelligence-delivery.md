# Financial intelligence delivery

Repository: `theroisey/else`, branch `main`, base `3f1cc0ec0c242f3ccc642110a494816e9a5bdd4c`. This change extends the existing application. Publication of an image is not evidence of a production rollout. No production database or customer volume was used for verification.

## Repository findings and reuse

The serving architecture is Rust/Pingora, React/Vite, SQLite and one process-owned transient Redis child, packaged in one scratch application image. Existing collections, payment/reversal ledgers, immutable service-period terms, allocations and internal settlements already provide the financial authority. Pricing proposals and restricted pricing costs are not actual payments or operating expenses. There was no independent operating-expense ledger suitable for reporting actual business spending.

The implementation reuses current session/refresh authentication, CSRF and Origin controls, current capability/client grants, admitted SQLite transactions, checked exact sums, commercial allocation calculations, typed audits, keyset paging, secure private transport, actor-partitioned React queries, themes, self-hosted fonts, five locales, embedded runtime and supported recovery. It creates no parallel accounting engine, scheduler, authentication system, public evidence store or external service.

## New functionality and navigation

`/app/finance/dashboard` is a separate Financial Dashboard destination. Existing `/app/finance` administration and brand finance remain available. The dashboard contains Overview, Receivables, Clients, Services, Partners, Payments, Expenses and Outlook. Supporting reconciliation, payment composition and cash/expense details use progressive disclosure.

There are UTC date presets/custom dates, currency, client search, service/agreement/partner, obligation status, actual collector, payment method, due-date and text filters. Tables have bounded pagination, exact current-page sorting and source drill-downs. Charts have semantic theme colors, consistent signed scales, keyboard labels and exact-value disclosures. The attention center presents deterministic rules and source navigation. Forecasts are explicitly hypothetical collection percentages against existing obligations; future agreement potential remains separate.

Expenses support configurable categories, internal or authorized brand context, vendor, description, currency, original dates/amount, partial payments, linked reversals, retained history and cancellation of unused obligations. List and CSV share expense status/category/title/vendor filters. Sensitive commands retain their original revision/payload in a workspace confirmation and require explicit reconciliation after uncertain responses. There is no automatic financial retry.

All new UI copy is supplied in English, Turkish, Romanian, German and French. The existing shell, mobile bottom navigation, official branding and loading-only fade behavior are preserved.

## Metrics and sources

See [financial policy](financial-intelligence.md) for exact definitions and bounds. In particular:

- Active/current obligations, net paid and outstanding come from retained collections. Cancelled obligations and retained payments are separated.
- Gross, reversed and net activity use payment/reversal business dates. Current position does not pretend to be a historical balance.
- Collection completion uses one coherent eligible obligation cohort. Average payments, counts, debtor count and prior-window/prior-year changes derive from the same exact data.
- Aging buckets reconcile with active outstanding, including missing due dates. Upcoming windows are cumulative and labelled.
- Client and service reports distinguish current exposure from selected-period payment activity. Restricted commercial terms remain unclassified.
- Partner receivables/payables reuse immutable period allocations and real internal settlements. Customer payments and internal transfers are separate.
- Expense obligations, actual paid/reversed spending, vendor/category and monthly summaries come from the independent retained expense ledger.
- Recorded cash movement includes known Roisey customer receipts, signed internal transfers and recorded paid operating expenses. Unknown collectors are disclosed and excluded; restricted or incompatible cohorts make the cash report unavailable.
- Attention rules cover old/undated debt, positive-client concentration, reversal ratio, unknown collector attribution, internal balances and near-term expense obligations.

## Backend/API and MCP

`backend/src/finance/{reporting,expenses,export}.rs` hold the domain logic; `backend/src/api/finance_routes.rs` provides transport. Read endpoints are `/api/v1/finance/dashboard`, `/finance/reports/{receivables|payments|clients}` and bounded `/finance/exports/{receivables|payments|clients|services|partners|aging|cashflow|expenses}`. Expense/category/history/mutation endpoints are documented in the policy.

Four read-only MCP tools extend the existing bridge: `else_financial_dashboard`, `else_financial_receivables`, `else_financial_payments` and `else_financial_clients`. The registry now has 125 tools. OAuth scopes never replace actual capabilities or the delegated client ceiling; linked client data also needs delegated client-read authority. No expense mutation tool is introduced.

## Migration and data preservation

`000009_financial_intelligence.sql` advances schema 8 to 9 through the established checksummed mechanism. It adds reporting indexes and four STRICT tables: `expense_categories`, `expenses`, `expense_events`, `expense_commands`. Triggers retain identity/history, verify original-payment lineage, enforce expected revisions and cap payment/reversal balances. Existing identifiers, old migrations and business rows are not rewritten.

The migration was exercised on disposable fixtures; execution against production was not performed. Index construction scans existing tables and should be included in the maintenance window. Use a supported backup before upgrading. Recovery inventories and expense-ledger verification include the new tables. There is no automatic downgrade or destructive rollback; schema-8 code must not be pointed at schema-9 storage. Recovery to an older release requires an appropriate pre-upgrade backup and reconciliation of later activity.

## Permissions and security

Company entry requires `finance.read_company`; every contributing client additionally requires current `clients.view` and `billing.view`. Commercial terms and partner calculations require current `agreements.view`. Expense access is independently controlled by new global `expenses.view` and `expenses.manage`; existing non-administrator roles receive no implicit expense grant. Brand-linked expenses require current client/billing authority; brand-scoped delegation excludes internal company expenses.

Authorization is repeated in the actual read/write transaction. Mutable private data bypasses the public service worker. Private DTOs reject unexpected fields, invalid exact values, mismatched context/parents and unordered pages. CSV is bounded to 512 KiB per authorized page, contains explicit currency/as-of/date definitions and escapes formula-like cells. No secrets or arbitrary financial text are added to logs/audits.

## Performance decisions

Core aggregates, source-bound checks, partner source periods and customer/settlement cash series share materialized eligible sets inside one batched SQL statement and one current read transaction. Reporting indexes support currency/client and event-date access. Complete working sets are bounded and oversized requests fail explicitly; detail/export pages use keyset continuation.

Mutable financial reports deliberately bypass Redis. A TTL-only cached total could survive a payment or grant change, so fresh authorization and coherent SQLite reads take precedence over speculative caching. Existing immutable provider caching is unchanged. The new route remains lazy-loaded; charts use SVG/CSS and add no dependency.

An initial exact-image rehearsal passed the mixed 100-user workload but returned read-admission 503s during a 20-request global-report burst. The correction shares the customer/settlement materializations across the report instead of rescanning them for each supporting section; it preserves the existing writer reservation and two-second admission bound. A subsequent burst still exceeded admission at roughly 129 ms per serialized report; current brand authority is now materialized once per statement, and only prepared SQL plans are reused. A further run accepted all burst requests but still exceeded two-second P95. Profiling identified query-projection preparation and redundant wide-integer accumulations. Immutable projection metadata is now initialized once, zero/ineligible aggregation callbacks are skipped, and outstanding is derived by checked subtraction from the same exact snapshot totals. The report also projects only required obligation columns, avoids a second wide materialization, and derives cumulative upcoming windows from a single set of exclusive buckets. No financial result or permission decision is cached between transactions. The original failure is retained here rather than treated as a passed gate.

The new reporting API did not exist at the baseline, so there is no equivalent before/after financial-endpoint measurement. Final build, browser and exact-image capacity evidence is recorded below; synthetic local samples are not a production SLA or physical-device benchmark.

## Verification and acceptance evidence

The standard `make check` passed (typecheck, ESLint, Rust format/Clippy, 483 frontend tests in 53 files and 118 Rust tests). After the load-driven backend changes, format/Clippy and the complete 119-test Rust suite passed again. Targeted frontend finance tests passed (5), the production build/typecheck passed, all five service-worker tests passed, and locale key parity was verified (271 keys in five bundles). `npm audit --include=dev --audit-level=info` found zero vulnerabilities. Both Rust advisory gates passed with zero vulnerabilities; the existing reviewed maintenance dispositions remain visible. Eleven publication tests, ten advisory-policy tests and the pinned-workflow validator passed.

The complete final exact-image browser suite passed all 36 scenarios, including actual HTTP reporting, all five chart intervals, CSV, expense creation, partial payment/reversal, grant revocation and responsive light/dark layouts at 360, 390, 430, 1280, 1440 and 1920 pixels. Screenshots were visually inspected. The browser measured one financial-filter update at 146 ms; this diagnostic is not field INP. Public-cache credential/challenge handling, offline isolation, safe updates and startup recovery also passed.

The same local image passed five startup refusal cases, HTTP/auth/runtime checks, retained expense payment/reversal backup and fresh-key restore, and production-shaped single-service Compose failure/restart/recovery checks. The MCP harness passed 27 measured cases and 1,350 requests with no failures, using the independent rmcp 3.5.1 client and both supported protocols. Its four financial tools were exercised through real OAuth grants, including client ceilings and insufficient-scope denial.

| Controlled capacity check | Final result |
| --- | --- |
| Workload | 500 clients, 100 concurrent users, 3,000 requests, 100 writes |
| Container limits | 2 CPUs, 256 MiB; observed memory 31.68 MiB |
| Mixed read / write P95 | 565.39 / 386.89 ms |
| Mixed P99 | 699.09 ms |
| Financial report, serialized P95 | 77.92 ms over 10,000 exact obligations |
| Financial report, 20-request burst P95 | 1,485.56 ms; original 2-second threshold passed |
| Frontend initial gzip | 196,220 bytes, 7 JavaScript requests; budget passed |

New domain tests cover exact large aggregates, currencies, partial/full collections, cancellation/reversal retention, due-date aging, current versus period semantics, commercial allocation/settlement direction, expense retries/conflicts, export escaping and scope revocation. The final added boundary assertions cover oversized source rejection and cumulative upcoming windows.

The tested source is `b10118018e87eff7788991022bb98f9a2fe14005`. Local worktree image ID: `sha256:91ff2b14d2f9446eab3336158c7b6a73e0cd05d56efe367d29419774b8b4bcab` (41,706,699 bytes). [Machine-readable evidence](performance/finance-2026-10-18.json) records binary/frontend fingerprints, exact image checks, complete load samples and measurement limits. This delivery commit adds documentation/evidence only. These controlled synthetic rehearsals are not a production SLA, live provider test, registry publication or deployment claim.

## Unsupported metrics and remaining limits

There is no supported complete bank balance, recognized accounting revenue/profit, automatic FX, historical receivable curve, inferred website allocation or inferred legacy collector. Known paid costs cannot prove complete organizational cost coverage. No legal tax invoicing, bank synchronization, recurring operating expenses or expense-document storage is invented. Existing evidence is request-bound and cannot safely be reparented as generic expense documents.

Position filters use current record attributes even when payment activity is historical. Separately fetched report pages are fresh snapshots, not a frozen bulk export. Limits are explicit in the policy. Row sorting applies to the current bounded page. No production verification, live provider test or physical iOS/Android test is claimed.

## Changed modules and delivery

Implementation: `backend/src/finance/`, API dispatcher/routes, additive migration, permission catalog, recovery, MCP registry/access/tests; `frontend/src/features/finance/`, route/navigation/prefetch, private transport, financial invalidations, shared semantic CSS and five locale bundles. Verification: finance browser workflow and existing container/recovery/capacity harness extensions. Documentation: README, financial policy/delivery report, frontend/operations/MCP notes and measured evidence.

Commit/push/CI identifiers are available in Git history and the linked task delivery. Work remains on `main`; no feature branch or PR is required by this repository's policy. Production deployment remains an operator action outside this change.
