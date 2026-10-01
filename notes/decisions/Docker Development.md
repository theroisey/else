---
type: decision
status: verified-in-followup-pr
created: 2026-10-01
tags:
  - architecture
  - docker
  - security
---

# Docker Development

Issue [#5](https://github.com/theroisey/else/issues/5) packages the existing applications and adds local three-service orchestration. The owner merged frontend [PR #37](https://github.com/theroisey/else/pull/37) and backend/root [PR #38](https://github.com/theroisey/else/pull/38), and #5 closed. [[CI and Publication]] subsequently supplied the combined runtime/container evidence and companion cache/quoting fixes.

## Decisions

- Keep the [[PostgreSQL Foundation]] TLS rule unchanged. Local preparation generates a CA-signed `postgres` certificate and distinct random bootstrap, migrator, and runtime credentials. Generated material stays ignored and outside build contexts.
- PostgreSQL initializes least-privilege roles on an empty persistent volume. Migrations run explicitly through a tools profile; the API never receives a migration/admin URL. Schema usage is granted after the baseline, with no blanket table grants.
- Only the frontend publishes a loopback port. Vite proxies same-origin requests and supports source hot reload. A local production override serves compiled assets with unprivileged nginx. Go runtimes are static scratch images with public roots and a silent readiness probe.
- Compose validates dependency readiness, and a private database network limits reachability. No business tables, business writes, production deployment, CI, or publication are added.

## Evidence and limits

Local Docker Hub pulls remain blocked by `toomanyrequests`. Issue #6's actual GitHub runs exposed and verified fixes for the reserved database-name quoting bug and non-root Vite cache ownership. PRs #39/#40 were owner-merged; run 36856821215 passed all gates and the controlled main publication. Later slices continue using the same full source/PostgreSQL/Compose gate.

See [Docker guide](../../docs/docker.md) for commands, renewal/reset boundaries, and proxy build secrets. [[Frontend Foundation]] remains the source of the browser behavior contract.
