# Roisey Else

Roisey Else is a client operations platform for financial tracking, pricing, tasks, planning, reminders, analytics, integrations, users, audit history, and releases. Each client has an authorized workspace.

## Current state

The initial audit on 2026-10-01 found an empty GitHub repository and a local checkout containing only `AGENTS.md` and Obsidian settings. The first implementation addresses [Issue #1: repository conventions and architecture baseline](https://github.com/theroisey/else/issues/1).

This baseline contains engineering documentation and contribution templates. Application code, database migrations, Docker services, automated checks, and authentication are not implemented yet. There is no application startup command at this stage.

## Engineering contract

Read [AGENTS.md](AGENTS.md) before planning or changing the repository. GitHub Issues are the source of scope and acceptance criteria. Permanent branches are `main`, `frontend`, and `backend`; application changes reach `main` through reviewed Pull Requests.

The owner approved a one-time empty root commit to establish the initial PR base. [The bootstrap record](docs/repository-bootstrap.md) documents that consumed exception. All subsequent changes to `main` use reviewed PRs.

## Repository ownership

- [frontend/](frontend/README.md): React, TypeScript, Vite, Tailwind CSS, and Font Awesome application.
- [backend/](backend/README.md): Go API, PostgreSQL access, migrations, permission checks, and audit infrastructure.
- `.github/`: issue templates, PR templates, and later CI workflows.
- [docs/](docs/architecture.md): architecture, contracts, and operating documentation.
- [notes/](notes/project/Repository%20Audit.md): Obsidian-compatible project memory. Local Obsidian UI settings are excluded from Git.

Folders acquire production code only through their own scoped Issues. No speculative module skeletons are required.

## Development roadmap

[The dependency roadmap](docs/roadmap.md) links the 32 implementation Issues across seven milestones. Start with repository conventions, then application foundations, PostgreSQL/migrations, Docker, CI, audit infrastructure, authentication, and authorization. Later slices add client operations, exact finance, measured integrations, and production readiness.

Each implementation must define its domain, permissions, audit behavior, and verification before coding. Cross-cutting slices use coordinated backend and frontend PRs with explicit API contracts.

## Product direction

The frontend uses a monochrome operational design: compact navigation, dense tables, restrained borders and radii, accessible forms, and deliberate typography. Color communicates status. Demo data must be visibly synthetic; integration and financial values must never appear live unless they come from verified records.

## Verification

Issue #1 uses document/link/dependency review, ignore-rule checks, and whitespace validation. Runtime test, lint, typecheck, migration, and Docker commands will be added by their foundation Issues. These missing checks must not be reported as passing.

## License

No license has been selected. Repository visibility does not grant reuse rights. An owner must explicitly choose a license before one is added.
