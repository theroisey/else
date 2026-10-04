# One application Docker image

Related: [#32](https://github.com/theroisey/else/issues/32). The root Dockerfile builds React with pinned Node/npm and Go with its pinned toolchain, then produces one scratch runtime image. One Go process serves the built UI and versioned API on port 8080. Node, npm and Nginx are absent from the runtime. Static API, healthcheck, migration, admin bootstrap and credential rotation binaries share the same image, public CA roots and nonroot UID/GID 65532. PostgreSQL remains an external database or a separate vendor infrastructure container.

Docker Engine with BuildKit, Compose 2.24.4+, and host openssl are required. Dockerfile syntax, Node 24.21.0, Go 1.27.1 and PostgreSQL 18.3 bases retain reviewed digest pins.

## Clean local startup

From the repository root:

```sh
sh docker/dev/prepare.sh
docker compose build backend
docker compose up -d --wait postgres
docker compose run --rm migrate up
docker compose exec -T postgres psql -U postgres -d else < backend/scripts/grant-runtime.sql
docker compose up -d --wait
```

Open http://localhost:5173. The historical service name `backend` now serves the whole application. Only its loopback port is published. Migrations run explicitly, never during API startup. Bootstrap uses `docker compose run --rm bootstrap-admin` with an interactive terminal and the documented [initial administrator policy](identity.md). Tool services use exactly the application image with an entrypoint override; only these operator processes receive the migrator URL.

Preparation generates three independent passwords in ignored mode-600 .env and local CA-signed PostgreSQL TLS material, refusing to overwrite existing files. The CA signing key is discarded; the server key stays mode 600. Certificates expire after 365 days: renew certificates privately and recreate PostgreSQL/application mounts without changing established database passwords. Runtime and migrator roles are separate nonsuperusers. Only reviewed functions/columns are granted. Database URLs use verify-full and read-only CA mounts; the database network is internal.

Application and tool containers use read-only root filesystems, drop capabilities and prohibit privilege escalation. No frontend source or dependencies are mounted into the runtime. For hot reload, use the documented host npm development workflow with a separately started API; Docker always exercises the built artifact.

## Health, persistence and isolated verification

```sh
docker compose run --rm migrate status
curl --fail http://localhost:5173/status
curl --fail http://localhost:5173/health
curl --fail http://localhost:5173/ready
docker compose ps
docker compose stop
docker compose up -d --wait
```

Status/health report process liveness; readiness checks the actual database and turns 503 during outage/drain. Stop/restart/down preserve the named database volume. A later database outage does not automatically stop its consumers. Do not share rendered Compose config or container environments: they contain private database URLs. Validate with `config --quiet`.

`sh backend/scripts/test-compose.sh` tests a committed checkout in a unique project, temporary private credentials/TLS and disposable volume. It checks migrations, runtime role denials, TLS hostname rejection, static/API routing and security headers, database outage/recovery, persistence, immutable release metadata, protected key-source startup and same-image rotation/inventory diagnostics. After success it archives exactly `else-application:ci`. The production Compose override is retained for existing local verification commands; base Compose already uses the production artifact.

## Managed build CA

When CODEX_PROXY_CERT is provided, add `-f docker-compose.proxy.yml` to the build command. The session CA is mounted as a BuildKit secret for dependency installation only. Keep platform proxy configuration and TLS verification. No session CA is copied into the final image.

## Deployment and tools

Publication promotes one tested repository, `ghcr.io/theroisey/else`, with immutable revision/version policy and a guarded latest alias; see [CI](ci.md). Pin a verified content digest for deployment. Existing split frontend/backend tags are historical artifacts and are not published by this workflow.

Operator commands use that same pinned image with `--entrypoint /migrate`, `--entrypoint /bootstrap-admin` or `--entrypoint /rotate-integration-credentials`, the appropriate private database/CA/key mounts and explicit authorization. See [rotation](integration-rotation-command.md) and [recovery](recovery.md). Bundling commands confers no privileges on the API: its database identity stays least privileged.

Deploy on a managed platform supporting a persistent Go container, HTTPS ingress and private PostgreSQL connectivity. Vercel's ordinary static/Node deployment does not run this image; choose a compatible managed container host before rollout. Set AUTH_PUBLIC_ORIGIN to the exact HTTPS origin, AUTH_COOKIE_SECURE=true, verified database TLS, per-replica connection budgets and protected mounted key material. Do not trust arbitrary forwarded identity headers. Edge throttling, secret ownership, monitoring and explicit rollout authority remain deployment requirements.

FRONTEND_DIRECTORY is an optional absolute startup path for standalone API development; the image sets /frontend. Startup snapshots only bounded index/JS/CSS/font build files, rejects symlinks, source maps, secrets and unknown files, and caps total assets at 64 MiB per replica. SPA navigation is limited to implemented public/app routes; API/health paths never fall back to HTML. Static responses revalidate content ETags with no-cache; private API/errors retain no-store. Strict [browser security headers](browser-security.md) apply across responses.

For a deliberately disposable reset, `docker compose down --volumes` destroys the local database. Never use that command against a volume containing needed data. Follow the recovery runbook for durable environments.

## Local verification for #32

The one-image Compose rehearsal passes actual TLS/permissions/migrations/routing/outage/persistence/header/release/key-source/operator checks. Docker export contains one application image, 53,109,105 bytes, UID/GID 65532. All Go race tests, vet/static builds, 454 frontend tests, lint/typecheck/build, compiled-Go CSP attack checks and 15 real browser flows pass. Full PostgreSQL 18.3 race integration passes in 557.028s, including actual recovery rehearsals. Local browser proof used an isolated generated copy with test port 5177 and system Chromium to preserve an existing user listener. Exact-head remote CI and registry publication remain unverified while GitHub jobs fail before runner assignment; no production deployment has occurred.
