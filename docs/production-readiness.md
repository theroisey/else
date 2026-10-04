# Production operating runbook

This runbook completes the operating design under [#32](https://github.com/theroisey/else/issues/32). The reference target is a **managed OCI container host with managed PostgreSQL**, serving the built React application and Go API at one HTTPS origin. This satisfies the user's managed web deployment requirement and preserves the required single application image. A Node-only/serverless Vercel function cannot run this long-lived Go application and worker unchanged. Actual hosting account, region, domain, database tier and traffic release remain the repository owner's rollout decisions; none is provisioned by this work.

## Artifact and process topology

Develop only on `main`; do not create additional issues or branches for this remaining work. Six CI gates precede publication to `ghcr.io/theroisey/else`. The publication job downloads the **tested image archive**, checks revision labels and promotes that artifact; it does not rebuild application code. Select an immutable digest with its source revision, completed CI run and Release Center metadata. A mutable `latest` tag alone is insufficient release evidence.

Use the same digest for all application roles:

| Role | Executable | Initial replicas | Database connection ceiling |
| --- | --- | --- | --- |
| Web, including built React assets | `/api` | 2 | 10 each |
| Independent analytics synchronization and bounded retention | `/analytics-worker` | 2 | 2 each |
| Reviewed migration | `/migrate` | One temporary process | 1 |
| Administrator bootstrap or key inventory/rotation | Bundled operator executable | One temporary process | Budget separately; no concurrent rollout |

Four web replicas support the planned growth reference topology without changing storage/session architecture: 40 web + 4 worker + 1 migration connections. Reserve at least 20 additional database connections for monitoring, backup, recovery and transient replacement overlap. A database allowing 100 total connections has useful headroom under that topology, subject to its actual reserved slots and other consumers. Never let autoscaling or rolling replacement exceed the reviewed total connection budget. Start with two web replicas and verify the target before increasing to four; synthetic local capacity is not a production SLA.

PostgreSQL is separate infrastructure, not a second application image. No Redis, queue server, Node runtime, Nginx image or provider-specific image is required. Database sessions, authorization and provider jobs are shared; web requests need no sticky sessions. Static startup assets consume at most 64 MiB per web process. Plan memory for that snapshot, Go/runtime overhead and up to two simultaneous bounded Argon2 operations per web process. Begin target measurement with at least 512 MiB memory per web replica and 256 MiB per worker, then size from observed RSS/CPU and login bursts; these are provisioning starting points, not measured limits.

## Configure an isolated release

1. Record source revision, image digest, expected migration version and compatibility decision. Provision the application service and PostgreSQL privately in the same region. Keep PostgreSQL off the public application ingress. Configure supervised restart and a graceful stop allowance exceeding the default ten-second API shutdown deadline; worker interruption must preserve its lease/fence recovery semantics.
2. Provision independent nonsuperuser migration-owner and runtime identities as described in [database.md](database.md). Revoke PUBLIC schema/function access, apply the reviewed embedded migrations with `/migrate up`, inspect `/migrate status`, and apply the checked-in [runtime grants](../backend/scripts/grant-runtime.sql) using the owner identity. Web and workers receive only the runtime URL. Migration/bootstrap credentials must never reach their environment.
3. Supply `DATABASE_URL` privately with explicit host, port and database, `sslmode=verify-full` and an approved CA path. Mount the CA read-only. The application rejects ambient libpq service configuration and unsupported URL options. Do not weaken TLS to accommodate a hostname mismatch.
4. Set `HTTP_ADDRESS=0.0.0.0:8080`, `AUTH_PUBLIC_ORIGIN` to the exact public HTTPS origin and `AUTH_COOKIE_SECURE=true`. Keep the image's `FRONTEND_DIRECTORY=/frontend`. Configure the gateway to forward all application/API paths to the same service. Preserve Host and Origin semantics; forwarded identity headers never establish authentication. Avoid cross-origin routing and private-response caching.
5. For provider setup/workers, mount a protected regular key file readable by UID/GID 65532 and configure the documented [key-source settings](integration-key-startup.md). All writers must agree on active identity/material. Without keys, existing reports remain readable but setup refuses safely; workers refuse startup. Never place keys, provider tokens or database passwords in labels, URLs, build arguments, source, screenshots or logs.
6. Run as image UID/GID 65532, read-only root filesystem, dropped capabilities and `no-new-privileges`. Mount only approved read-only CA/key sources. Bootstrap once interactively through the bundled operator with the approved owner URL; passwords are never command arguments. Test authorized and denied routes with disposable records before opening traffic.

The [single-image local procedure](docker.md) supplies reproducible clean-environment TLS, roles, migration, outage, persistence, protected-source and header checks. Its generated local credentials/certificates and loopback HTTP configuration are disposable rehearsal inputs. Production uses the host's secret manager, trusted TLS and durable database service.

## Request, query and background bounds

Common dashboard/CRUD interactions target 1–2 seconds under normal load. The [capacity procedure](capacity-readiness.md) uses a two-second per-route P95 screening ceiling and a three-second client failure bound. Preserve the independent [HTTP/SQL limits](runtime-budgets.md): default request 5s, readiness 2s, runtime statement 5s, lock wait 2s and idle transaction 10s. These are failure ceilings, not response-time promises. Runtime pools use zero minimum, 30-minute maximum connection lifetime and five-minute idle lifetime.

Directory/domain/provider catalogs use bounded pages and keyset continuation. Overview reads use bounded queues and explicit permission checks. Provider reports use exact indexed client/connection/generation/period partitions and validate stored DTOs before returning them. Private API responses and failures use `no-store`; static assets use content ETags with `no-cache` revalidation. Do not add a shared private-data cache that can outlive current grants. Measure actual plans with safe synthetic data before adding indexes; routine autovacuum/ANALYZE and storage growth remain database operations.

Web handlers enqueue audited provider work and return; they never wait for vendor synchronization. GA4, WooCommerce and Meta share **two globally live database leases**, even across worker replicas. Workers use separate pools and no database transaction during network collection. Individual operations are bounded to 150s, provider collection to 120s, and leases to 180s. Expired work is fenced and attempts are bounded; failures require explicit user retry, never blind retries after uncertain mutations. See [GA4](ga4-synchronization.md), [WooCommerce](woocommerce-synchronization.md) and [Meta](meta-synchronization.md) for exact provider restrictions. Confirm the actual target's permitted vendor DNS/HTTPS egress and compatible credentials before enabling each connection. No external notification service is implemented.

## Health, monitoring and incidents

Use `/health` for process liveness and `/ready` for bounded database connectivity readiness. Route traffic only to ready replicas. Database outage leaves liveness healthy and readiness 503; restart loops do not repair a database. Readiness is not schema, privileges, provider ownership, backup or complete business-flow proof.

Collect the existing fixed structured logs and server-generated request IDs through the hosting log sink. Retain only approved diagnostic fields; never enable SQL argument/body/cookie/Authorization logging at the gateway or database. Configure provider failure/worker startup alarms from fixed events. Use the host's HTTP latency/status/CPU/RSS metrics and PostgreSQL connection/lock/statement/storage/backup metrics; no application Prometheus endpoint is claimed.

Before traffic, the owner must name the rollout approver, incident commander/on-call contact, database/backup operator and secret custodian in a restricted operating record. The repository owner remains the approval authority until a delegation is explicitly recorded. Configure actionable starting alerts: ready replicas zero; sustained API 5xx >1% for five minutes; common-route P95 >2s for five minutes; database connection usage >75% of reviewed usable slots; disk >80%; repeated worker failures; oldest queued work exceeding its expected bounded service window; failed/missing backup; restore drill overdue. Tune thresholds against real traffic and on-call response capacity. These are operating recommendations, not installed monitoring or approved service guarantees.

On an incident: restrict affected traffic/writers, preserve revision/digest/migration and safe correlation evidence, assess scope, and choose a reviewed forward repair or compatible artifact rollback. Refresh current revision/history after uncertain writes. For a provider-specific failure, pause affected workers or locally disconnect the account; local fencing does not verify remote token revocation. Perform remote revocation in vendor settings under account authority. For a secret incident, exclude old writers and use the documented protected key inventory/rotation workflow; retain keys required by ciphertext and backups. Never delete audit/history or reuse rewound encryption budgets as an incident shortcut.

## Backup, restore and rollback acceptance

Follow [recovery.md](recovery.md) for matching PostgreSQL custom archives, protected durable storage, isolated empty-database restore, exact fingerprints/ACL/sequence/history checks, declared restore with a fresh active key and retained decrypting keys, post-checkpoint reconciliation, and source-compatible artifact rollback. The automated test actually restores archives and runs current → pinned prior → current binaries. Its older Meta-only source deliberately refuses mixed-provider metadata. It is **not a general rollback candidate** for this release's three provider contracts. Prefer a tested compatible current/previous single-image digest or a forward repair; preserve schema and history.

Before release, select and record actual database backup/PITR retention, restore location, encryption/access policy and recovery objectives with the operator. Suggested planning goals for this initial scale are RPO ≤15 minutes and RTO ≤4 hours **only if the chosen managed database and rehearsed procedure can support them**. Obtain explicit owner acceptance of the measured objectives; do not infer them from a small local fixture. Complete a target-specific restore drill with actual role mapping, protected key mounts, TLS and immutable artifacts before declaring those objectives achieved. A successful backup command or managed vendor feature checkbox is not a restore test.

## Final traffic checklist

- Verify all six CI gates at the chosen main revision and publication of exactly the tested image; record the digest and source/build metadata privately with the release.
- Verify target same-origin HTTPS, secure cookies, denied CSRF/client/financial routes, security headers, explicit narrow database grants, expected migration version and protected key sources.
- Exercise a disposable authorized CRUD mutation with exactly one audit, all three report states and background admission; review actual edge/database/provider errors, request latency and connection headroom.
- Confirm durable backups, target restore/rollback compatibility, retained keys, accepted recovery objectives, monitored alarms and named incident/secret/database ownership.
- Obtain the repository owner's explicit target/traffic approval and record the release externally. Release Center is read-only; no deployment execution integration or append-oriented deployment writer exists. No production rollout is performed by this readiness issue.
