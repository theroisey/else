# Roisey Else

Roisey Else is a client operations platform for financial tracking, pricing, tasks, planning, reminders, analytics, integrations, users, audit history, and releases. Each client has an authorized workspace.

## Current state

The initial audit on 2026-10-01 found an empty GitHub repository and a local checkout containing only `AGENTS.md` and Obsidian settings. [Issue #1](https://github.com/theroisey/else/issues/1) establishes the repository baseline; [Issue #2](https://github.com/theroisey/else/issues/2) adds the Go HTTP foundation.

The current implementation contains engineering documentation, a Go/PostgreSQL backend, a typed React frontend, verified containers/CI, [atomic audit infrastructure](docs/audit-log.md), [secure identity and cookie sessions](docs/identity.md), and [permission-based RBAC](docs/authorization.md). Issue #11 adds the [monochrome accessible interface foundation](docs/interface-foundation.md). Login UI, administration routes, client records and business modules remain later slices.

Run the backend from `backend/` using `go run ./cmd/api` with Go 1.27.1. [The HTTP guide](docs/backend-http.md) documents configuration; [the identity guide](docs/identity.md) adds the required public origin, cookies, bootstrap and auth endpoints; [the authorization guide](docs/authorization.md) defines permission/scope checks. `/health` reports liveness and `/ready` checks PostgreSQL. Export runtime DATABASE_URL securely before startup; [the database guide](docs/database.md) documents migrations and grants.

Run the frontend from `frontend/` using `npm ci` and `npm run dev` with Node 24.21.0/npm 11.19.0. [The frontend guide](docs/frontend-foundation.md) documents checks and same-origin development routing. The screen displays real service availability; client operations are not implemented.

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

Issue #1 uses document/link/dependency review, ignore-rule checks, and generated-file whitespace validation; the original AGENTS.md formatting is preserved. Issue #2 adds Go formatting, vet, unit/race tests, and native/Linux builds. Issue #3 adds reproducible frontend installation, lint, typecheck, component/service tests, production build, dependency audit, and real-browser checks. Issue #4 adds real PostgreSQL migration/permission/readiness tests and a disposable integration runner. Issues #5/#6 provide verified Docker builds and CI. Issue #7 adds audit atomicity/privilege checks; Issue #8 adds password, session, CSRF, throttle, bootstrap and identity permission checks; Issue #9 adds authorization matrices, scope isolation, escalation prevention and audited-assignment checks; Issue #11 adds token, primitive, keyboard, contrast and responsive visual checks.

## License

No license has been selected. Repository visibility does not grant reuse rights. An owner must explicitly choose a license before one is added.
