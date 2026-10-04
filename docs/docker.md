# One image, one container

The standard distribution has one Compose service, `else`, one exposed port, and one named persistent volume. PostgreSQL 18.3, the Go API, built React assets, and the analytics worker ship in `ghcr.io/theroisey/else`. The root multi-stage Dockerfile builds pinned Node/npm and Go toolchains; neither Node nor npm is present at runtime. No Nginx or separate database/migration service is required.

## Installation

```sh
git clone git@github.com:theroisey/else.git
cd else
cp .env.example .env
docker compose up -d
```

Docker Engine and Compose 2.24.4+ are sufficient. The existing GHCR package must allow public reads for login-free installation; package visibility is an owner setting, separate from publication. Private packages require an authorized Docker registry login. Open http://localhost:8080 after health becomes ready. `docker compose exec -it else /opt/else/operator bootstrap-admin owner@example.com 'Owner'` creates the first administrator through a hidden password prompt; there is no default login.

Startup initializes only an empty `18/docker` cluster, loads durable generated credentials, provisions distinct migration/runtime identities, applies pending migrations and reviewed grants, provisions protected keys, then starts API and worker. Existing clusters and records are preserved. Incompatible or partially initialized clusters are refused without deletion. Failed migrations prevent application startup. Managed volumes recover crash-stale PID files only under the exclusive lock with no live PostgreSQL process; an unclean legacy adoption is refused for operator review.

## Processes and security

Tini runs as PID 1 and reaps descendants. The Bash supervisor tracks PostgreSQL, API, and worker, including early startup exits. Any required-child exit terminates the whole container with a failure status. TERM/INT drains application children, then sends PostgreSQL a fast clean shutdown; bounded fallback handles stuck children. Compose gives 60 seconds for shutdown.

The supervisor/operator runs as root with limited capabilities for initialization and identity changes. PostgreSQL is UID 999, API/worker UID 65532, and migration/bootstrap UID 65533. The root filesystem is read-only, `/run` and `/tmp` are bounded tmpfs mounts, and privilege escalation is disabled. API/worker cannot read PGDATA or root-private credential files. Database owner credentials never reach them.

PostgreSQL listens only on 127.0.0.1 inside the container. Local administrator access uses a private peer-authenticated socket; other local users are rejected. SCRAM protects loopback application connections. No PostgreSQL port is published. The prior separate-container TLS requirement remains applicable to standalone non-loopback development databases; this distribution uses private intra-container loopback transport.

## Persistence and upgrades

The single `else_data` volume mounts at `/var/lib/roisey-else`. It contains `18/docker` (database) and `.control` (private generated credentials and integration keyring). Its default physical name is `roisey-else_postgres-data`, preserving the former root Compose volume. A cross-container flock refuses simultaneous ownership.

```sh
docker compose ps
docker compose logs -f else
docker compose exec -T else /opt/else/operator migrate status
docker compose restart else
docker compose pull
docker compose up -d --wait
docker compose stop
docker compose down
```

These retain the volume. Set `ELSE_IMAGE` to a verified digest for production and back up before upgrading. Image replacement has a maintenance interruption; do not horizontally replicate this embedded database distribution. PostgreSQL major-version upgrades require an explicit tested migration procedure, not an image swap.

**Destructive reset:** `docker compose down --volumes` deletes all data and keys. Use only for disposable environments.

## Existing installation adoption

Before changing the old deployment, save an off-host database backup and every retained integration key. Stop all old API/worker/database containers. Inspect the actual old named volume privately (`docker volume ls`) and set `ELSE_DATA_VOLUME` to that physical name; custom Compose projects do not use the default name. PostgreSQL must be major version 18 with the existing `18/docker` layout. Never mount two owners concurrently.

The supervisor preserves the cluster and app data while provisioning private credentials and updating role passwords/grants. Old `.env` database password settings are unnecessary. Existing `.env` origin settings must be updated to port 8080 or your chosen port; use the new example as a reference without losing retained configuration. Stop the old stack with `down` **without** `--volumes` before replacing its Compose file.

If encrypted integration credentials exist, install the retained keyring before normal startup; startup refuses to generate replacement keys over existing ciphertext. With the service stopped:

```sh
docker compose run --rm --no-deps --entrypoint /opt/else/operator else install-keyring < /protected/retained-keyring.json
```

This is an administrative file installation, not a database restore; retain original registered identities/material. Restart after installing. For restored database history, follow [offline recovery](recovery.md) and use a fresh active key.

## Local build and managed build CA

```sh
docker build -t roisey-else:local .
ELSE_IMAGE=roisey-else:local docker compose up -d --wait
```

When `CODEX_PROXY_CERT` exists, supply `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` to `docker build`, or use `docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.proxy.yml build else` with CI build settings. The CA is a BuildKit dependency-download secret and is never copied into the runtime. Public CA roots support provider HTTPS.

The production overlay is retained as a compatibility overlay; base Compose already uses the production runtime. Static assets are immutable build output, served by Go with the existing route allowlist, ETags, and browser security headers.

## Verification and publication

`sh backend/scripts/test-compose.sh` builds committed HEAD in a unique project and disposable volume. It verifies one service/port/volume, all automatic migrations/grants, restricted process identities, API/SPA routing, real client persistence, clean shutdown, replacement, required-child and migration failures, volume locking, actual backup/restore, release stamps, and key/operator safeguards. Canonical CI archives exactly the tested image; local worktree/prebuilt shortcuts cannot produce publication artifacts.

After publication, `ELSE_TEST_DISTRIBUTION_IMAGE=ghcr.io/theroisey/else:sha-<full-checked-out-commit> sh backend/scripts/test-distribution-upgrade.sh` rehearses the literal published `pull`, fresh automatic startup, authenticated client creation, `down`, `pull`, and `up` with retained records in its own disposable volume. It checks actual compiled release metadata against the checked-out revision. Never point it at an operator/customer volume.

All six CI gates remain required. Publication promotes one image repository with immutable full-revision tags and guarded `latest`, without rebuilding. See [CI](ci.md). Publishing is not production traffic approval.
