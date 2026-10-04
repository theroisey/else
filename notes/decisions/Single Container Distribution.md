---
type: decision
status: active
created: 2026-10-05
tags:
  - architecture
  - docker
  - operations
---

# Single Container Distribution

The user explicitly requests React, Go, and PostgreSQL in one image, one running container, one Compose service, one exposed application port, and one persistent named volume. This supersedes [[Single Application Image]]'s external PostgreSQL topology and the earlier managed-database replica plan. Work remains on main under existing #32; no new issue or branch is needed.

Preserve domain code, SQL migration history, narrow runtime grants, private credential/key boundaries, all six CI gates, and promotion of the exact tested image. Use a supervised PostgreSQL/API/worker lifecycle with automatic initialization/migrations, safe failure, and graceful shutdown. The API never receives migration-owner credentials or performs startup DDL.

Retain the legacy PostgreSQL volume name and PostgreSQL 18 cluster path so normal adoption cannot silently replace customer data with an empty database. Initialization must refuse partial or incompatible clusters. Existing encrypted credentials require retained key material; losing or rewinding key history must not be repaired by unsafe fresh-key substitution. Keep interactive administrator bootstrap rather than introducing a preset password or password environment variable.

The distribution intentionally has one local authoritative database. Multiple containers sharing its PGDATA are unsupported; vertical sizing and durable backups replace the former standard multi-replica deployment guidance. Separate Vite/Go development and isolated PostgreSQL test fixtures remain supported.

## Verification

The root production image built successfully. The isolated actual-container rehearsal passed fresh automatic initialization of all 25 migrations and narrow grants; one service/port/volume; nonroot PG/API/worker identities; API/SPA/header routing; authenticated client persistence through restart, clean stop, recreation and image-reference replacement; adoption of the legacy PostgreSQL 18 layout without control files; exclusive volume ownership; incompatible/partial cluster refusal; mandatory-migration and early API failure; forced PostgreSQL death, whole-container failure, and WAL recovery; real custom archive generation; protected-key source/restore freshness checks; and offline import, failed-key startup blocking, fresh retained-key verification and restored client/history reads.

Go vet/race checks, workflow syntax, publication guards (9 tests), and recovery-helper boundaries (5 tests) passed. Full real PostgreSQL integration passed in 551.471 seconds, including finance, authorization, provider encryption/history, capacity, logical restoration and compatible-artifact limits. These are local/synthetic results, not a production SLA or traffic approval.

The forced-crash rehearsal exposed stale `postmaster.pid` PID reuse across container namespaces. Managed-volume recovery now removes only that transient lock while holding the exclusive filesystem lock and observing no live PostgreSQL process. An unclean legacy cluster without the managed marker is refused for reviewed recovery rather than altered silently.

All six main CI gates and exact tested-image promotion remain required. The publication job additionally rehearses real GHCR pull, fresh startup, authenticated client creation, and retained-data `down`/`pull`/`up` using the published immutable revision. Package visibility is an owner setting: the existing registry rejected anonymous pulls during this task, so login-free installation remains contingent on Public read access. No new issue/branch or production rollout is created.
