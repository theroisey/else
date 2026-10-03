# Roisey Else

Roisey Else is a client operations platform for financial tracking, pricing, tasks, planning, reminders, analytics, integrations, users, audit history, and releases. Each client has an authorized workspace.

## Current state

The initial audit on 2026-10-01 found an empty GitHub repository and a local checkout containing only `AGENTS.md` and Obsidian settings. [Issue #1](https://github.com/theroisey/else/issues/1) establishes the repository baseline; [Issue #2](https://github.com/theroisey/else/issues/2) adds the Go HTTP foundation.

The current implementation contains engineering documentation, a Go/PostgreSQL backend, a typed React frontend, verified containers/CI, [atomic audit infrastructure](docs/audit-log.md), [secure identity and cookie sessions](docs/identity.md), [permission-based RBAC](docs/authorization.md), the [monochrome accessible interface foundation](docs/interface-foundation.md), and [real login and the permission-aware shell](docs/application-shell.md). Issue #10 delivers [user/role administration](docs/administration.md), with paginated tables, validated forms and confirmed access changes. Owner-merged Issue #13 adds the [client API](docs/clients.md), with real records, contacts/tags, exact-scope access and archival. Owner-merged Issue #14 adds the [client interface](docs/client-interface.md): authorized tables, forms, conflict recovery and compact workspaces. Owner-merged Issue #15 adds the [task API](docs/tasks.md), with explicit transitions, eligible scoped assignees, optimistic revisions and audited archival. Owner-merged Issue #16 adds the [task interface](docs/task-interface.md): scoped tables, validated editing, status/reopen controls and confirmed archival. Owner-merged Issue #17 adds the [planning API](docs/planning.md) and [planning interface](docs/planning-interface.md): scoped plans/milestones, date windows, explicit lifecycle, conflict-safe drafts and retained task-link history. Owner-merged Issue #18 adds the [reminder API](docs/reminders.md) and [reminder interface](docs/reminder-interface.md), with explicit timezone schedules/occurrence choices, eligible owners, historical resource references, conflict-safe drafts and audited completion/dismissal. Owner-merged Issue #22 adds the [client activity API](docs/activity.md) and [activity timeline](docs/activity-interface.md): authorized persisted events with exact UTC times and safe pagination. Issue #28 adds the owner-merged [audit-read API](docs/audit-reader.md) and separately reviewed [audit viewer](docs/audit-interface.md), with explicit global/client visibility, exact filters and safe before/after differences. Issue #19 adds the separately reviewed [exact collections/payment API](docs/billing.md): currency-separated exact money, append-only payments, conflict/retry protection and retained cancellation history. Issue #20 adds the [finance workspace](docs/billing-interface.md), with exact amount entry, server balances, guarded payment recovery and retained cancellation history. Other business modules remain later slices.

Run the backend from `backend/` using `go run ./cmd/api` with Go 1.27.1. [The HTTP guide](docs/backend-http.md) documents configuration; [the identity guide](docs/identity.md) adds the required public origin, cookies, bootstrap and auth endpoints; [the authorization guide](docs/authorization.md) defines permission/scope checks. `/health` reports liveness and `/ready` checks PostgreSQL. Export runtime DATABASE_URL securely before startup; [the database guide](docs/database.md) documents migrations and grants.

Run the frontend from `frontend/` using `npm ci` and `npm run dev` with Node 24.21.0/npm 11.19.0. [The frontend guide](docs/frontend-foundation.md) documents checks and same-origin development routing. `/app` requires a real account/session; `/status` displays service availability. Match the backend auth public origin to the browser origin; `/app/clients` exposes client capabilities allowed by the current grants.

Owner-merged Issue #21 adds the [versioned pricing backend](docs/pricing.md) and [pricing interface](docs/pricing-interface.md): exact server previews, immutable effective history, restricted internal costs and explicit collection copies with retained billing terms and lost-response recovery.

Owner-merged Issue #23 adds the [client overview backend](docs/client-overview.md) and separately reviewed [overview interface](docs/overview-interface.md): exact finance, bounded due tasks/reminders and safe recent activity through one read-only request with independent module grants. The editorial responsive client root links to retained profile management and real source workspaces.

Parent #24 advances [integration security boundaries](docs/integrations.md) in separate slices. Owner-merged #68 supplies credential encryption/key rotation and #70 frontend permission compatibility. Owner-merged #72 adds durable secret-free connection metadata and authorized bounded list/detail reads, with independent clients.view and integrations.view grants. Owner-merged #74 adds durable per-key encryption budgets and audited reservations. Owner-merged #76 adds private encrypted credential persistence and single-row retained-key rewrap, with fresh management grants, full revision/generation fences and atomic audits. No application connections are seeded. Owner-merged #78 adds confirmed local disconnect with immediate fencing and explicit unavailable remote revocation. Owner-merged #80 adds the [client integration interface](docs/integration-interface.md), with metadata paging/detail, confirmed local disable and manual revocation recovery. Issue #82 adds [protected key startup and declared restore checks](docs/integration-key-startup.md). Undeclared restore detection, bulk rotation/key retirement, verified provider connection actions/OAuth/remote revocation and synchronization remain incomplete.

## Engineering contract

Read [AGENTS.md](AGENTS.md) before planning or changing the repository. GitHub Issues are the source of scope and acceptance criteria. Permanent branches are `main`, `frontend`, and `backend`; application changes reach `main` through reviewed Pull Requests.

The owner approved a one-time empty root commit to establish the initial PR base. [The bootstrap record](docs/repository-bootstrap.md) documents that consumed exception. All subsequent changes to `main` use reviewed PRs.

## Repository ownership

- [frontend/](frontend/README.md): React, TypeScript, Vite, Tailwind CSS, and Font Awesome application.
- [backend/](backend/README.md): Go API, PostgreSQL access, migrations, permission checks, and audit infrastructure.
- `.github/`: issue templates, PR templates, and CI workflows.
- [docs/](docs/architecture.md): architecture, contracts, and operating documentation.
- [notes/](notes/project/Repository%20Audit.md): Obsidian-compatible project memory. Local Obsidian UI settings are excluded from Git.

Folders acquire production code only through their own scoped Issues. No speculative module skeletons are required.

## Development roadmap

[The dependency roadmap](docs/roadmap.md) links the 32 implementation Issues across seven milestones. Start with repository conventions, then application foundations, PostgreSQL/migrations, Docker, CI, audit infrastructure, authentication, and authorization. Later slices add client operations, exact finance, measured integrations, and production readiness.

Each implementation must define its domain, permissions, audit behavior, and verification before coding. Cross-cutting slices use coordinated backend and frontend PRs with explicit API contracts.

## Product direction

The frontend uses a monochrome operational design: compact navigation, dense tables, restrained borders and radii, accessible forms, and deliberate typography. Color communicates status. Demo data must be visibly synthetic; integration and financial values must never appear live unless they come from verified records.

## Verification

Issue #1 uses document/link/dependency review, ignore-rule checks, and generated-file whitespace validation; the original AGENTS.md formatting is preserved. Issue #2 adds Go formatting, vet, unit/race tests, and native/Linux builds. Issue #3 adds reproducible frontend installation, lint, typecheck, component/service tests, production build, dependency audit, and real-browser checks. Issue #4 adds real PostgreSQL migration/permission/readiness tests and a disposable integration runner. Issues #5/#6 provide verified Docker builds and CI. Issue #7 adds audit atomicity/privilege checks; Issue #8 adds password, session, CSRF, throttle, bootstrap and identity permission checks; Issue #9 adds authorization matrices, scope isolation, escalation prevention and audited-assignment checks; Issue #11 adds token, primitive, keyboard, contrast and responsive visual checks; Issue #12 adds session-recovery/permission UI tests and a real API browser-authentication CI gate.

## License

No license has been selected. Repository visibility does not grant reuse rights. An owner must explicitly choose a license before one is added.
