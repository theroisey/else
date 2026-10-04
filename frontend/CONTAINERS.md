# Container distribution

The root [Dockerfile](../Dockerfile) builds React and Go and includes PostgreSQL in one production image. Standard Compose has one `else` service and publishes loopback port 8080. Go serves compiled assets and `/api/v1` from one origin; no Node/npm/Nginx runtime or frontend container exists.

Run `cp .env.example .env` and `docker compose up -d` from the repository root. Database initialization, migrations, grants, private keys, and the analytics worker are automatic. To build local source, run `docker build -t roisey-else:local .`, then `ELSE_IMAGE=roisey-else:local docker compose up -d --wait`.

The allowlisted `.dockerignore` excludes local configuration, credentials, dependencies, and generated assets. API/worker run as UID 65532 on a read-only root filesystem; PostgreSQL has its own UID and persistent data. The root supervisor handles startup and graceful process shutdown. Hot reload uses standalone Vite/API development; Docker serves compiled assets.

See [Docker operations](../docs/docker.md), [browser headers](../docs/browser-security.md), [recovery](../docs/recovery.md), and [publication gates](../docs/ci.md). No production rollout is implied by publication.
