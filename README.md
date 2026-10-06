# Roisey Else

A private workspace for managing client accounts, daily operations, finances, and measured business performance.

Roisey Else brings the work around each client into one place. See what needs attention, keep agreements and payment history precise, and review analytics without mixing accounts or currencies. Access follows each person's current permissions, with a recorded history of important changes.

[![CI](https://github.com/theroisey/else/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/theroisey/else/actions/workflows/ci.yml)

## What you can do

- Maintain client profiles, contacts, tags, and independent websites.
- Assign tasks, organize plans and milestones, and schedule reminders with explicit timezones.
- Track collections, partial payments, overdue balances, and immutable pricing agreements.
- Read GA4 analytics, WooCommerce order/refund reports, and Meta Ads performance for the selected client and reporting period.
- Manage users, roles, and global or client-specific access; inspect audit history and authorized activity.
- Work in Light, Dark, or System appearance, with English, Turkish, Romanian, German, and French interfaces.

Archival keeps authorized history available. Financial amounts stay exact and separated by currency. Provider reports distinguish measured, empty, stale, and unavailable data.

## Quick start

You need Docker with Compose, Make, and Python 3. Use a Linux x86-64 Docker host with persistent local storage.

```sh
git clone https://github.com/theroisey/else.git
cd else
cp .env.example .env
make up
make bootstrap
```

The bootstrap command privately prompts for the first administrator's email, display name, and password. It works once on an empty installation. Open [http://localhost:8080](http://localhost:8080) and sign in. There is no preset password or demo account.

If access to the repository or container package is private, authenticate your Git and Docker clients first. Docker registry authentication belongs to the host; the application does not need a GitHub token.

Compose runs exactly one container named `else`. Rust serves the interface and API as PID 1, handles background synchronization, and owns a private embedded Redis cache. SQLite stores durable records. The runtime needs no host Node installation or separate database/cache service.

## Configuration

Edit `.env` before starting or recreating the container.

| Setting | Purpose | Default |
| --- | --- | --- |
| `APP_PORT` | Application port published on host loopback | `8080` |
| `AUTH_PUBLIC_ORIGIN` | Exact URL origin used in the browser | `http://localhost:8080` |
| `AUTH_COOKIE_SECURE` | HTTPS-only authentication cookies | `false` for local use |

For public hosting, set the exact HTTPS origin and `AUTH_COOKIE_SECURE=true`, then route your hosting platform's HTTPS ingress to the loopback application port. This deployment needs a persistent Linux container host and local durable storage.

Compose uses `ghcr.io/theroisey/else:latest` and the fixed `roisey-else-data` volume. Redis starts automatically inside the same container and listens only on private loopback. It stores disposable report projections, has no published port, and writes no persistent cache files.

## Updates and everyday operation

```sh
make update       # Pull the application image and recreate the container, retaining data
make logs         # Follow application logs
make restart      # Graceful application restart
make down         # Stop and remove containers; retain stored data
make up           # Start again
```

The equivalent update commands are:

```sh
docker compose pull
docker compose up -d --wait --wait-timeout 60
```

Take a verified backup before upgrading and review compatibility before rolling back code. Updates are explicit host operations. The application does not poll registries or deploy itself.

## Your data

Client records, identities, permissions, financial history, reports, and encrypted provider credentials live in the fixed `roisey-else-data` volume. The durable database is `else.sqlite3`; protected encryption keys live in `.control/integration-keyring.json`. Retain the complete volume and the keys required by retained backups.

`make down` preserves the volume. Removing that volume or using `docker compose down --volumes` can permanently remove your records. `make clean` removes build output only.

Provider setup accepts manually provisioned read credentials and queues background work. Reading a report never contacts the provider. GA4 uses a service-account key, WooCommerce a dedicated Read consumer key/secret, and Meta a compatible user token with `ads_read`. Local disconnect immediately fences application use; revoke remote access in the provider's account settings as well.

## Backup and restore

Create a new verified checkpoint while the application is running:

```sh
make backup BACKUP_NAME=checkpoint-20261006
```

The bundle is stored at `backups/checkpoint-20261006` inside your application volume. It includes a consistent database backup, retained encryption keys, and a verification manifest. The command refuses to overwrite an existing checkpoint. Copy it to protected, encrypted off-host storage:

```sh
umask 077
mkdir -p private-backups
docker compose cp else:/var/lib/roisey-else/backups/checkpoint-20261006 private-backups/
```

Do not copy the actively written database file as an ordinary backup. Use the supported backup command and rehearse restoration.

To restore on a recovery host with **empty fixed storage**, copy the complete checkpoint to a private directory owned by your operator account. Before its first startup:

```sh
make restore BACKUP_SOURCE=/absolute/private-backups/checkpoint-20261006
make up
```

Keep the original installation and off-host bundle. Restore refuses a running application or populated database, verifies exact histories and retained keys, and adds independent fresh active encryption material. Failed verification keeps recovery storage blocked for investigation. The wrapper stages the private bundle with the container's ownership without running the application as root. Take a new supported checkpoint after an additive schema upgrade; bundles must match the supported snapshot schema.

The [operations guide](notes/operations.md) covers recovery reconciliation, key retention and safe incident handling.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Image pull denied | Authenticate the host Docker client for the package's visibility/access policy. |
| Port already used | Change `APP_PORT` and the matching local `AUTH_PUBLIC_ORIGIN`; recreate the application. |
| Login or write rejected | Use the exact configured origin and current permissions. Check HTTPS cookie configuration. |
| No initial administrator | Run `make bootstrap`; existing installations require an authorized administrator. |
| Data directory unavailable | Inspect the logged owner/mode or filesystem error. Fresh storage inherits UID/GID 65532 and mode 0700; preserve existing data before trusted ownership repair. |
| Startup or readiness fails | Inspect `make logs` for the fixed failure code; preserve storage before repair. |
| Report synchronization fails | Check the selected provider's credential, account access, period, public DNS/TLS, and outbound connectivity. |
| Restore is refused | Use empty fixed storage on the recovery host and a complete supported bundle with retained keys. |

`/health` checks process liveness. `/ready` verifies SQLite, the owned Redis child and a non-draining server. Redis startup failure exits; unexpected child death drains Rust and triggers a whole-container restart while SQLite records remain durable. Logs name the failing startup stage and a safe error code. Check locally with:

```sh
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

## Development

The frontend uses React and TypeScript; the backend uses Rust and Pingora with relational SQLite. Source builds need Node 24.21.0/npm 11.19.0, Rust 1.99.0, a C compiler, CMake, OpenSSL development tools, Docker, ELF/binutils utilities, and musl tooling for the static production target.

```sh
make install
make dev-bootstrap
make dev
```

In another terminal, `make frontend` starts frontend hot reload at `http://127.0.0.1:5173`. The backend listens at `127.0.0.1:8080`; local development data stays under `.local/data`. Use `make check` for source checks, and `make docker` to build frontend assets, the static Rust binary and the pinned embedded Redis artifact **before** packaging the single scratch image. Redis preparation retains only its executable, five required libraries and upstream notices.

`make help` lists verification, image, migration, key, and recovery workflows. Read [AGENTS.md](AGENTS.md) and the concise [maintenance notes](notes/architecture.md) before changing contracts. All six CI gates precede promotion and signed verification of the exact tested image. Publication does not deploy production traffic.

## License

No public application license has been declared. Third-party dependency and font license notices ship with the image; they do not license Roisey Else itself.
