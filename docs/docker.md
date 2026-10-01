# Docker development environment

Related Issue: [#5](https://github.com/theroisey/else/issues/5), merged through frontend #37 and backend #38. Docker Engine with BuildKit, Compose 2.24.4 or newer, and host `openssl` are required. Node 24.21.0, Go 1.27.1, PostgreSQL 18.3, nginx, and the Dockerfile frontend are pinned by version and digest. [Issue #6's CI guide](ci.md) describes isolated development/runtime verification and publication gates.

## First startup

From the repository root in a clean checkout containing both PRs:

```sh
sh docker/dev/prepare.sh
docker compose build frontend backend migrate
docker compose up -d --wait postgres
docker compose run --rm migrate up
docker compose exec -T postgres psql -U postgres -d else -v ON_ERROR_STOP=1 -c 'GRANT USAGE ON SCHEMA app TO else_runtime; GRANT INSERT (actor_kind, actor_user_id, event_name, resource_kind, resource_id, client_id, request_id, before_state, after_state, metadata) ON app.audit_events TO else_runtime; GRANT EXECUTE ON FUNCTION app.audit_snapshot_allowed(jsonb) TO else_runtime'
docker compose up -d --wait
```

Open `http://localhost:5173`. Health and readiness checks use the frontend origin and proxy to the backend. No client, identity, finance, or other domain endpoint is introduced. `src/` is mounted read-only for Vite hot reload; package/config changes require a rebuild. The container's installed dependencies are never replaced by host dependencies.

The preparation script generates three independent random passwords into ignored, mode-600 `.env` and a local CA-signed PostgreSQL certificate with the `postgres` DNS name into ignored `docker/dev/tls/`. It refuses to overwrite existing material. The CA signing key is discarded; the server key remains mode 600. Keep `.env` private and with its named database volume. The certificates expire after 365 days. Renewal needs a replacement server certificate and CA generated privately, followed by PostgreSQL/backend recreation with the new files; do not regenerate passwords for an existing database. For a disposable reset, see below.

PostgreSQL initializes runtime and migration roles once when its volume is empty. Neither role is superuser, role administrator, or database creator; only the migrator owns the database and may change its schema. The API receives only the runtime URL, and the migration profile receives only the migration URL. Bootstrap admin credentials stay with PostgreSQL. The post-migration command grants schema usage only; no blanket table grants or new domain tables are added. Later migrations must define their own grants.

Both URLs use `sslmode=verify-full` and a read-only CA mount. PostgreSQL copies its key into a private, postgres-owned volume directory before the official entrypoint starts the non-root server. Shared networking does not weaken the backend's loopback-only plaintext policy. The database health check connects using the runtime identity over verified TLS; the backend health check calls real `/ready`; frontend startup waits for backend readiness. Migrations are an explicit deployment step and never run at API startup.

## Everyday use and verification

```sh
docker compose run --rm migrate status
curl --fail http://localhost:5173/health
curl --fail http://localhost:5173/ready
docker compose ps
docker compose stop
docker compose up -d --wait
```

`stop`, `restart`, and `down` preserve the named volume. Only localhost's frontend port is published; neither PostgreSQL nor the backend publishes a host port. The database network is internal. The dev server is intended for a trusted local workstation.

For persistence proof, apply the baseline, stop/down and start the services again, then check that migration status still shows it applied. For readiness outage proof, stop PostgreSQL after the stack is healthy: `/health` remains 200 and `/ready` becomes 503; start PostgreSQL and readiness should recover. `depends_on` controls initial startup; it does not stop consumers when a dependency fails later. Normal logs contain fixed events and safe error classifications. Avoid printing `docker compose config`, inspecting container environments, or sharing `.env`: rendered configuration includes database URLs/passwords. Use `config --quiet` for validation.

## Static runtime verification

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml build frontend backend migrate
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --wait
```

The override replaces the frontend bind mount and port mapping with nginx on container port 8080. nginx and the Go runtime use non-root users. The Go image contains static executables and public CA roots; the frontend runtime contains compiled assets, without npm tooling or database secrets. `/status` checks nginx liveness and `/ready` checks the backend. This is local runtime-image verification, not production deployment. Production credential storage, ingress/TLS, rollout, backups, and image publication belong to later Issues.

## Managed proxy builds

When a managed cloud environment supplies `CODEX_PROXY_CERT`, add `-f docker-compose.proxy.yml` to build commands. The override supplies the session CA as a BuildKit secret only during networked dependency installation. Preserve the environment's Docker proxy defaults. Certificate verification remains enabled and the CA is not copied into image layers. Ordinary local builds use the base Compose file without this override.

## Disposable reset

Changing `.env` does not change passwords in an initialized database. Never discard a volume to fix credentials for valuable data. Only when all data in this local development project is disposable, `docker compose down --volumes` removes it permanently. Then remove this project's `.env` and `docker/dev/tls/`, run preparation again, and repeat first startup. Rollback with `docker compose run --rm migrate down` reverts one migration; the audit migration refuses nonempty history, and the baseline refuses a nonempty application schema. Reapply explicit grants after an empty audit down/up. See [audit storage](audit-log.md).

## Validation status

Compose base/production/proxy configuration, shell syntax, generated-certificate hostname acceptance/rejection, private credential/key permissions, ignore rules, and refusal to overwrite existing credentials are validated. Go 1.27.1 formatting, vet, unit/race tests, and static binary builds pass. Node 24.21.0/npm 11.19.0 installation, lint, 16 frontend tests, typecheck, production build, and resolved container/host routing checks pass.

Local image builds remain blocked by Docker Hub's unauthenticated pull limit. Issue #6's [GitHub PR run 36852928372](https://github.com/theroisey/else/actions/runs/36852928372) passes all source, PostgreSQL, and combined Compose gates, including development/static-runtime image builds, TLS/role checks, migration round-trips, same-origin routing, readiness recovery, persistence, and non-root runtimes. The gate exposed the unquoted reserved database name; provisioning now quotes "else", and the companion frontend fix supplies writable Vite caches. Those corrections are verified together in CI PR #40 and await review/merge. Base-image digests are resolved and pinned. Main publication remains unobserved.
