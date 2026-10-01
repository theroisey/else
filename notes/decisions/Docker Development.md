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

Issue [#5](https://github.com/theroisey/else/issues/5) packages the existing applications and adds local three-service orchestration. The owner merged frontend [PR #37](https://github.com/theroisey/else/pull/37) and backend/root [PR #38](https://github.com/theroisey/else/pull/38), and #5 closed. Both development branches were synchronized before Issue #6. Their runtime/container evidence remains incomplete; [[CI and Publication]] adds automated gates and a companion fix for non-root Vite cache ownership.

## Decisions

- Keep the [[PostgreSQL Foundation]] TLS rule unchanged. Local preparation generates a CA-signed `postgres` certificate and distinct random bootstrap, migrator, and runtime credentials. Generated material stays ignored and outside build contexts.
- PostgreSQL initializes least-privilege roles on an empty persistent volume. Migrations run explicitly through a tools profile; the API never receives a migration/admin URL. Schema usage is granted after the baseline, with no blanket table grants.
- Only the frontend publishes a loopback port. Vite proxies same-origin requests and supports source hot reload. A local production override serves compiled assets with unprivileged nginx. Go runtimes are static scratch images with public roots and a silent readiness probe.
- Compose validates dependency readiness, and a private database network limits reachability. No business tables, business writes, production deployment, CI, or publication are added.

## Evidence and limits

Original source/configuration checks passed, but local Docker Hub pulls remained blocked by `toomanyrequests`; the owner merged #37/#38 with runtime verification incomplete. Issue #6's actual GitHub runs exposed the reserved database-name quoting bug and the non-root Vite cache ownership gap. Follow-up [PR #39](https://github.com/theroisey/else/pull/39) and [PR #40](https://github.com/theroisey/else/pull/40) correct those issues and pin all base manifests. [Run 36852928372](https://github.com/theroisey/else/actions/runs/36852928372) passes the full source/PostgreSQL/Compose suite, including builds, verified TLS, runtime privilege denials, migration round-trips, routing, readiness recovery, volume persistence, and non-root runtimes. The fixes await review/merge; controlled main publication remains pending.

See [Docker guide](../../docs/docker.md) for commands, renewal/reset boundaries, and proxy build secrets. [[Frontend Foundation]] remains the source of the browser behavior contract.
