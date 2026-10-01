---
type: decision
status: proposed
created: 2026-10-01
tags:
  - architecture
  - docker
  - security
---

# Docker Development

Issue [#5](https://github.com/theroisey/else/issues/5) packages the existing applications and adds local three-service orchestration. Frontend packaging and backend/root orchestration have separate companion PRs; both are required for a runnable checkout.

## Decisions

- Keep the [[PostgreSQL Foundation]] TLS rule unchanged. Local preparation generates a CA-signed `postgres` certificate and distinct random bootstrap, migrator, and runtime credentials. Generated material stays ignored and outside build contexts.
- PostgreSQL initializes least-privilege roles on an empty persistent volume. Migrations run explicitly through a tools profile; the API never receives a migration/admin URL. Schema usage is granted after the baseline, with no blanket table grants.
- Only the frontend publishes a loopback port. Vite proxies same-origin requests and supports source hot reload. A local production override serves compiled assets with unprivileged nginx. Go runtimes are static scratch images with public roots and a silent readiness probe.
- Compose validates dependency readiness, and a private database network limits reachability. No business tables, business writes, production deployment, CI, or publication are added.

## Evidence and limits

Compose configurations, shell syntax, certificate hostname checks (including rejection), secret file permissions/ignore rules, and refusal to overwrite credentials validate. Go 1.27.1 formatting/vet/race tests/static builds and Node 24.21.0/npm 11.19.0 installation/lint/16 tests/typecheck/build/routing checks pass. The managed environment has Docker Engine access but no cached images. Docker Hub rejects Node and digest-pinned PostgreSQL pulls with `toomanyrequests` (unauthenticated rate limit). Container build/startup, TLS/role behavior, migrations, nginx routing, and persistence remain unverified. Keep PRs draft until those checks pass. Node/Go/nginx versions are explicit; immutable digest resolution remains part of restoring the container verification gate, before release publication.

See [Docker guide](../../docs/docker.md) for commands, renewal/reset boundaries, and proxy build secrets. [[Frontend Foundation]] remains the source of the browser behavior contract.
