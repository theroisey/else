---
type: decision
status: merged-unverified
created: 2026-10-01
tags:
  - architecture
  - docker
  - security
---

# Docker Development

Issue [#5](https://github.com/theroisey/else/issues/5) packages the existing applications and adds local three-service orchestration. The owner merged frontend [PR #37](https://github.com/theroisey/else/pull/37) and backend/root [PR #38](https://github.com/theroisey/else/pull/38), and #5 closed. Both development branches were synchronized before Issue #6. Their runtime/container evidence remains incomplete; [[CI and Publication]] adds automated gates and a companion fix for non-root Vite cache ownership.

## Decisions

- Keep the [[PostgreSQL Foundation]] TLS rule unchanged. Local preparation generates a CA-signed `postgres` certificate and distinct random bootstrap, migrator, and runtime credentials. Generated material stays ignored and outside build contexts.
- PostgreSQL initializes least-privilege roles on an empty persistent volume. Migrations run explicitly through a tools profile; the API never receives a migration/admin URL. Schema usage is granted after the baseline, with no blanket table grants.
- Only the frontend publishes a loopback port. Vite proxies same-origin requests and supports source hot reload. A local production override serves compiled assets with unprivileged nginx. Go runtimes are static scratch images with public roots and a silent readiness probe.
- Compose validates dependency readiness, and a private database network limits reachability. No business tables, business writes, production deployment, CI, or publication are added.

## Evidence and limits

Compose configurations, shell syntax, certificate hostname checks (including rejection), secret file permissions/ignore rules, and refusal to overwrite credentials validate. Go 1.27.1 formatting/vet/race tests/static builds and Node 24.21.0/npm 11.19.0 installation/lint/16 tests/typecheck/build/routing checks pass. The managed environment has Docker Engine access but no cached images. Docker Hub still rejects Node pulls with `toomanyrequests` after the merge. Container build/startup, TLS/role behavior, migrations, nginx routing, and persistence remain unverified. The original PRs were draft with this warning, then owner-merged; Issue #6's checks must resolve the evidence gap. Node/Go/nginx versions are explicit; immutable digest resolution remains incomplete.

See [Docker guide](../../docs/docker.md) for commands, renewal/reset boundaries, and proxy build secrets. [[Frontend Foundation]] remains the source of the browser behavior contract.
