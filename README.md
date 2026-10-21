# Roisey Else

A private workspace for managing client accounts, daily operations, finances, and measured business performance.

Roisey Else brings the work around each client into one place. See what needs attention, keep agreements and payment history precise, and review analytics without mixing accounts or currencies. Access follows each person's current permissions, with a recorded history of important changes.

[![CI](https://github.com/theroisey/else/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/theroisey/else/actions/workflows/ci.yml)

## What you can do

- Maintain client profiles, contacts, tags, and independent websites.
- Start in Today with authorized tasks, requests, delivery reviews, notifications, and an owner-only currency-separated financial snapshot.
- Connect advertising employees and developers through website-linked requests, private screenshots, decisions, versioned deliveries, approvals, and revisions.
- Organize advertising teams and brand responsibilities without granting company finance to employees.
- Assign tasks, organize plans and milestones, and schedule reminders with explicit timezones.
- Track collections, partial payments, overdue balances, and immutable pricing agreements.
- Record service agreements, the actual collecting party, consulting allocations, internal settlements, and audited payment reversals.
- Open a separate Financial Dashboard for exact collections, receivables aging, client/service comparisons, partner balances, recorded operating expenses and cash movement.
- Generate daily, weekly, and monthly tasks and contractual billing periods automatically, with retained schedule/price versions and duplicate prevention.
- Read GA4 analytics, WooCommerce order/refund reports, and Meta Ads performance for the selected client and reporting period.
- Manage users, roles, and global or client-specific access; inspect audit history and authorized activity.
- Connect compatible AI clients through the native MCP bridge, with scoped consent, current permissions and browser approval for sensitive changes.
- Work in Light, Dark, or System appearance, with English, Turkish, Romanian, German, and French interfaces.

Archival keeps authorized history available. Financial amounts stay exact and separated by currency. Provider reports distinguish measured, empty, stale, and unavailable data.

## Daily work

Today is the operational starting point. Employees see their assigned brands, personal work and requests; developers see the shared technical queue; leaders see their authorized team's work. Owners retain management and finance access under their individual accounts. Inside a brand, Summary, Work, Websites, Finance and More keep daily actions close while preserving planning, analytics, integrations and audit tools. More expands a row of authorized advanced links that wraps on smaller screens; Escape closes it and returns focus to the button. Finance appears only with the required permissions.

On phones and tablets, bottom navigation provides Today, Tasks, Requests and Clients according to your access. More opens the remaining authorized pages; Escape or Close returns to your work. The desktop sidebar remains available on larger screens. Native date fields fit their forms, and the bottom bar leaves room for form actions and device safe areas.

Create the client first, then add its independent properties in Websites. There is no primary website selector. Existing website records and historical values remain intact. On the sign-in page, appearance and language preferences are available as text buttons in the footer.

Browser tabs use the supplied 16px and 32px favicons. On mobile, use your browser's Add to Home Screen or Install app action. Platform-sized PNG icons are resized directly from the original 2048px black R + ELSE artwork with Lanczos filtering and light sharpening for iOS and Android. The shortcut opens the authenticated workspace in its own window on supported browsers; it needs a network connection. After updating the deployment, existing shortcuts may need to be removed and added again to refresh the device's cached icon.

Production includes a bounded service worker on HTTPS or loopback. It caches only verified public scripts, styles and fonts as they load; pages, account data and writes still need a connection. Updates do not reload open work. Save your drafts and close all application tabs and installed windows to activate a waiting update. If startup files are unavailable, the recovery screen explains whether to reload or close and reopen for an update.

Appearance and language are available in Settings and the account menu. Startup and session loading show the original unframed Roisey mark in both themes. Navigation is immediate; only loading indicators fade. Long dialog titles wrap within the screen, and metric summaries keep consistent alignment across responsive rows. The separate My Access page has been removed.

The interface loads operational pages and optional languages as needed. Common destinations warm in the background without reading customer records; Save Data connections skip speculative downloads. Subtle movement provides interaction feedback and respects reduced-motion preferences. See the [frontend performance report](notes/frontend-performance.md) for measured results and verification limits.

An employee selects a brand and website, explains an issue and attaches a screenshot. A developer accepts or rejects it with a recorded decision, assigns accepted work and submits a delivery. The requester or authorized leader reviews the result, approves it or requests a reasoned revision. Before/after evidence and every delivery version stay attached to the original request. Developers cannot approve their own deliveries.

Create real accounts through Users, then create a team, add its leader and employees, and assign brand responsibilities through Team. Use the dedicated advertising employee role rather than the legacy Viewer role, which retains its historical finance permissions. The second owner needs a separate account with the authorized full administrator role; no additional people or customer records are seeded. Settings groups appearance and language under Workspace, personal delivery preferences under Notifications, assistant access under AI connections, and the authorized business timezone under Organization. Switching categories preserves unsaved entries while Settings remains open.

## Service finances and automation

A 1,000 USD maintenance obligation remains separate from a 700 EUR consulting obligation. A consulting split of 200 EUR for Roisey and 500 EUR for the advertising partner is included in the original 700 EUR. If the partner collects all 700 EUR, the customer owes zero and the partner owes Roisey 200 EUR internally. If Roisey collects it, Roisey owes the partner 500 EUR. Internal transfers never charge the customer again.

The default split recognizes collected funds proportionally: collecting 350 EUR recognizes 100 EUR for Roisey and 250 EUR for the partner, with 350 EUR still due from the customer. An explicitly selected contractual policy can use the agreed full allocation instead. Refunds retain original payments and adjust the customer's and internal balances; advertising media spend stays independent. This is operational financial tracking, not legal tax invoicing.

Active schedules run inside the existing application process; no extra container or external cron is required. Each task occurrence and service billing period has a durable unique identity. Monthly schedules clamp short months to their last day and return to the original anchor afterward. Pause/resume affects future generation, and historical terms remain intact. The worker rechecks its configured manager's current authority and exposes failures for authorized reconciliation. See the [operations platform guide](notes/operations-platform.md) for limits, permissions and recovery.

## Financial intelligence

Open **Financial Dashboard** directly from navigation; existing Finance and client billing pages retain their operational workflows. Select one currency and reporting period, then investigate clients, services, partners, payment events, expenses or collection outlook. Current balances are labelled separately from historical payment activity. Comparisons use equal-length previous periods and the corresponding prior-year dates; missing positive baselines never produce a percentage. Charts include exact accessible tables and a cumulative collections view.

Company reporting requires `finance.read_company`; every contributing client still requires current client and billing access. Contract terms and partner positions require agreement access. Operating expenses have separate `expenses.view` / `expenses.manage` permissions and retained positive payments, linked reversals and original-command reconciliation. Only the designated full administrator receives the new permissions automatically.

The panel focuses on interactive reports and does not show CSV export controls. Existing secured export API endpoints remain compatible. Known cash movement is not a bank balance or accounting profit; unknown historical collectors and unrecorded spending are disclosed. Forecasts do not issue customer charges. See [financial intelligence definitions and operations](notes/financial-intelligence.md).

## Quick start

You need Docker with Compose, Make, and Python 3. Use a Linux x86-64 Docker host with persistent local storage.

```sh
git clone https://github.com/theroisey/else.git
cd else
cp .env.example .env
make up
make bootstrap
```

The bootstrap command prompts for the first administrator's registered email and display name, without a password. It works once on an empty installation. Configure verified SMTP delivery before sign-in; then open [http://localhost:8080](http://localhost:8080), enter your email and paste the six-digit code. There is no public registration or password fallback. See [passwordless setup and recovery](notes/authentication.md).

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

Take a verified backup before upgrading and review compatibility before rolling back code. Save work and close existing application tabs after upgrading to let a waiting public-asset worker activate; reopen the panel and check the new build. See [static-delivery verification and recovery](notes/static-delivery.md) for release checks. Updates are explicit host operations. The application does not poll registries or deploy itself.

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

## AI connections

MCP is disabled until an authorized administrator enables it in Settings → AI connections. Register your client’s exact OAuth callback URLs, configure the `/mcp` endpoint and registered public client ID, then sign in and choose the capabilities and brands to delegate. Your current permissions always remain the ceiling. Sensitive changes require your exact approval in the browser before the assistant can execute them.

The bridge supports 2026-07-28 discovery and 2025-11-25 initialization through JSON-response Streamable HTTP. It requires a client that supports pre-registered OAuth/PKCE applications; automatic dynamic registration, subscriptions and stdio are not provided. See [setup, security and proxy guidance](notes/mcp.md) and [verification evidence](notes/mcp-delivery.md). The existing single image and data volume remain unchanged.

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

### Workspace refinements

Use the question icon in the header for a short guide to the current section. Settings includes Light/Dark/System appearance and optional browser alerts. Alerts require browser permission and an open panel (background tabs are supported); private details remain inside the application. No closed-browser push provider is required.

Sign-in now uses a six-digit email verification code for existing active accounts. Codes expire after three minutes, can be used once, and can be resent after one minute. Check spam or contact an administrator if delivery fails; never share a code. Mailbox access is the authentication factor, so email OTP is not phishing-resistant. New accounts need no password. Existing valid sessions remain valid and current permissions still apply. Schema 10 adds private challenges, durable abuse limits and an encrypted temporary SMTP outbox; existing identities, roles and business records are preserved. The old password endpoint is retired.

New sign-ins receive rotating, HttpOnly refresh cookies with a fixed seven-day limit. Access sessions retain their twelve-hour lifetime, renew automatically while authorized, and end on logout, account disablement, expiry or detected token reuse. Legacy sessions are not silently upgraded. Schema 10 is additive; take a verified checkpoint before upgrading and a new checkpoint afterward, and use a schema-compatible artifact for rollback. No production database reset is involved.

Production serves a small application entry with route and locale chunks, separate CSS/fonts and the small pre-paint theme script. For day-to-day development, `make check-changed` runs source-impact checks; the full `make check` and image/browser gates remain required before release.
