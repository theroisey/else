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

**Upgrading an earlier PostgreSQL installation:** stop and follow the [conserved import procedure](notes/operations.md#existing-postgresql-installations) before starting this image on its volume. Unconverted storage is refused rather than replaced with an empty installation.

Compose runs one application container. It serves the interface and API, processes background synchronization, and stores persistent data. Node and a database server are not required on your host.

## Configuration

Edit `.env` before starting or recreating the container.

| Setting | Purpose | Default |
| --- | --- | --- |
| `APP_PORT` | Application port published on host loopback | `8080` |
| `AUTH_PUBLIC_ORIGIN` | Exact URL origin used in the browser | `http://localhost:8080` |
| `AUTH_COOKIE_SECURE` | HTTPS-only authentication cookies | `false` for local use |
| `ELSE_IMAGE` | Selected application tag or immutable digest | `ghcr.io/theroisey/else:latest` |
| `ELSE_DATA_VOLUME` | Persistent application volume | `roisey-else_postgres-data` |
| `COMPOSE_PROFILES` | Set to `cache` to start optional Redis | Unset |
| `REDIS_URL` | Optional report cache address | Unset |

For public hosting, set the exact HTTPS origin and `AUTH_COOKIE_SECURE=true`, then route your hosting platform's HTTPS ingress to the loopback application port. Pin a verified image digest for controlled production updates. This application needs a persistent container host; ephemeral function or static-only hosting is unsuitable.

Redis is optional. To enable it, uncomment both cache settings in `.env` and run `make up`. Cache loss does not remove records or prevent normal database-backed operation.

## Updates and everyday operation

```sh
make update       # Pull selected images and recreate containers, retaining data
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

Take a verified backup before upgrading and review compatibility before selecting an older image. Updates are explicit host operations. The application does not poll registries or deploy itself.

## Your data

Client records, identities, permissions, financial history, reports, and encrypted provider credentials live in the selected named volume. The durable database is `else.sqlite3`; protected encryption keys live in `.control/integration-keyring.json`. Retain the complete volume and the keys required by retained backups.

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

To restore the checkpoint still held in the original volume into a **new, empty** recovery volume:

```sh
make down
make restore BACKUP_NAME=checkpoint-20261006 \
  SOURCE_VOLUME=roisey-else_postgres-data RESTORE_VOLUME=roisey-else-restored
ELSE_DATA_VOLUME=roisey-else-restored make up
```

Replace `SOURCE_VOLUME` if your installation uses another volume. Do not start the recovery volume before restoring it. Restore verifies the database, exact histories, and retained keys, and generates a fresh active encryption key before permitting startup. It refuses populated targets and preserves the source. After accepting the recovered installation, set `ELSE_DATA_VOLUME=roisey-else-restored` in `.env` for future commands.

The [operations guide](notes/operations.md) covers off-host bundle staging, migration, recovery reconciliation, and key retention.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Image pull denied | Authenticate the host Docker client for the package's visibility/access policy. |
| Port already used | Change `APP_PORT` and the matching local `AUTH_PUBLIC_ORIGIN`; recreate the application. |
| Login or write rejected | Use the exact configured origin and current permissions. Check HTTPS cookie configuration. |
| No initial administrator | Run `make bootstrap`; existing installations require an authorized administrator. |
| Legacy storage refused | Preserve the volume and use the explicit PostgreSQL import procedure. |
| Startup or readiness fails | Inspect `make logs` for the fixed failure code; preserve storage before repair. |
| Report synchronization fails | Check the selected provider's credential, account access, period, public DNS/TLS, and outbound connectivity. |
| Restore is refused | Select an empty target and a complete trusted bundle with all retained keys. |

Check local service health with:

```sh
curl --fail http://localhost:8080/health
curl --fail http://localhost:8080/ready
```

## Development

The frontend uses React and TypeScript; the backend uses Rust and Pingora with relational SQLite. Source builds need Node 24.21.0/npm 11.19.0, Rust 1.99.0, a C compiler, CMake, OpenSSL development tools, and musl tooling for the static production target.

```sh
make install
make dev-bootstrap
make dev
```

In another terminal, `make frontend` starts frontend hot reload at `http://127.0.0.1:5173`. The backend listens at `127.0.0.1:8080`; local development data stays under `.local/data`. Use `make check` for source checks, and `make docker` to build frontend assets and the static binary **before** packaging the single runtime image.

`make help` lists verification, image, migration, key, and recovery workflows. Read [AGENTS.md](AGENTS.md) and the concise [maintenance notes](notes/architecture.md) before changing contracts. All six CI gates precede promotion and signed verification of the exact tested image. Publication does not deploy production traffic.

## License

No public application license has been declared. Third-party dependency and font license notices ship with the image; they do not license Roisey Else itself.
