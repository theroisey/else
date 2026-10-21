# Passwordless authentication delivery — 2026-10-21

Repository: `theroisey/else`, branch `main`. Baseline: `476de13d0b437ea1dc7f2a01aafa608de16b2f5e`. The associated Git commit identifies the final source. No production deployment or production-data mutation was performed. The repository's main-only policy requires no feature branch or PR.

## Implemented behavior

Email-only sign-in issues a browser-bound opaque challenge for an existing active account. Unknown/disabled addresses receive the same public challenge shape without delivery or registration. A six-digit OS-generated code expires after 180 seconds, allows five guesses, and can be replaced after a 60-second cooldown. SQLite enforces independent email, direct-peer and global budgets across restarts. HMAC-SHA256 protects low-entropy verification values; a temporary encrypted SQLite outbox hands mail to one bounded asynchronous SMTP worker. No provider operation runs in a request or database transaction.

Successful verification consumes the delivered challenge, creates fresh ordinary access/refresh/CSRF credentials and records the session audit in one admitted transaction. Sessions remain HttpOnly/host-only/Strict, access lasts twelve hours and rotating refresh families retain their fixed seven-day deadline. Existing valid sessions and live permission checks remain effective. HTTPS refuses insecure-cookie mode. Password login returns 410; password verification and password-dependent user creation/bootstrap are removed. New accounts use an inert legacy-column marker; existing hashes/IDs/emails/grants/business records remain untouched.

The responsive login provides a native numeric one-time-code field, paste/keyboard support, automatic focus, relative expiry/resend timers, recoverable failures and five complete locales. Codes clear before transport and never enter query state or browser persistence. Existing branding, appearance, loading-only fades, navigation and service-worker privacy remain.

Normal profile editing cannot replace the authentication mailbox. A deliberate trusted-host `recover-email` command requires current administrator attribution, confirmation and revision, after independent identity/mailbox verification. It revokes sessions, pending codes/mail and delegated OAuth grants atomically with an audit. See [authentication policy and operator guide](authentication.md) for exact configuration, threat model, rollout and recovery instructions.

## Storage and compatibility

Additive checksummed migration `000010_email_otp.sql` adds `auth_otp_challenges`, `auth_otp_rate_events` and `auth_email_outbox`, with STRICT tables, foreign keys, a unique active challenge per account and bounded indexed cleanup. No existing table is rebuilt or reset. Only disposable test databases were migrated during verification; production migration was not run.

The retained application keyring supplies domain-separated OTP HMAC keys and authenticated outbox encryption, sharing irreversible nonce accounting. Supported backup verifies retained ciphertext; empty-target restore adds fresh active material, invalidates pending/delivered codes and removes temporary mail material before publication. Existing business history and row identities remain. There is no automatic downgrade: take a checkpoint before upgrade and a fresh schema-10 checkpoint afterward; use a compatible artifact or the documented empty-target recovery procedure.

SMTP supports mandatory STARTTLS or implicit TLS with certificate verification, bounded deadlines, a fixed verified sender and protected credential files. Plain SMTP is confined to explicitly configured loopback development fixtures. Failed/expired/superseded mail cannot authenticate. Ambiguous abandoned sends are invalidated instead of replayed. Authentication never falls back to Redis or passwords. Cache-evicting MCP benchmarks now require an owned image container; the native harness has no localhost cache-clear path.

## Executed verification

| Check | Result |
| --- | --- |
| `make check` | Passed: types, lint, Rust format/Clippy, **485 frontend tests / 53 files**, **132 Rust tests** |
| Service-worker tests | **5 passed**, including OTP request/verification bypass |
| Publication/advisory gate regression tests | **11 + 10 passed** |
| Production frontend build | Passed; initial JS **198,454 bytes gzip**, 7 initial JS requests; total JS **2,271,162 bytes**, within existing budgets |
| Static musl production build | Passed with the pinned Rust toolchain |
| Actual Pingora HTTP smoke | Passed with both SIGTERM and SIGINT, including malformed input, foreign Origin, browser binding, rate limits, replay, mailbox-update rejection and SMTP-based session creation |
| Browser workflows | **39 passed natively; 39 passed against the final exact image**; light/dark, mobile widths, five locales, refresh, permissions, finance, requests/deliveries, recurrence, MCP and cache/CSP checks |
| Image startup failure checks | **8 passed**, including unsafe SMTP policy, invalid OTP lifetime and HTTPS/insecure-cookie rejection |
| Exact image/runtime/recovery | Passed: default nonroot identity, Redis ownership/privacy, readonly root, HTTP/assets/auth, exact finance, persistence, both stop signals, online backup and fresh-key empty-target restore |
| Actual production Compose file with isolated fixture overrides | Passed: one service, readiness, child-failure restart, recreation, backup and off-host restore |
| MCP interoperability | Passed natively and in the image for both 2026-07-28 and 2025-11-25 using the official rmcp 3.5.1 independent client; isolated cache/overload benchmark passed |
| Capacity rehearsal | Passed: **500 clients, 100 users authenticated by email code, 3,000 requests / 100 writes**, 2 CPUs / 256 MiB; read P95 **609.07 ms**, write P95 **371.81 ms**, 20-user financial burst P95 **1,594.61 ms**, observed memory **33.58 MiB** |
| Genuine dependency scans | Application and independent client: **zero vulnerabilities** against RustSec database `4b587f00996ebe5c05a73eaef105ef241e876414` (1,348 advisories); two existing scoped Pingora maintenance advisories remain visible |

Security tests cover leading zeros, digest binding, failed guesses, expiration, replay, concurrent consumption, resend/supersession, active-user changes, durable budgets after database reopen, queue admission, account enumeration semantics, audit rollback, encrypted delivery failures, abandoned claims and legacy schema/session/grant preservation. Recovery tests include queued OTP ciphertext and verify that the source checkpoint remains unchanged while restored mail is invalidated. SMTP and browser fixtures are unshipped, explicitly synthetic and private; unrelated workflow scenarios reset only their own fixture counters. Dedicated security tests exercise real limiting.

The scan discovered and fixed RUSTSEC-2026-0382 in `rustls-webpki` (0.103.15 → 0.103.16), and related RUSTSEC-2026-0383 in the independent client's `webpki-root-certs` (1.0.9 → 1.0.10). No advisory or required CI context was disabled.

## Local artifact evidence and limits

Final local test image: `sha256:e85a7785d2cf94d2aa654efbfcd5bff90f3314dde6cf9d55db1d60fb2853effd`, **42,345,061 bytes** (40.38 MiB). Static application SHA-256: `0078373758972209c6e40e40e01336c9031d83838bad558fe3c3722170f4c6da`. The local image is labeled `otp-local-worktree`; it is not evidence of registry publication or a production rollout. CI must separately build, test and attest its saved artifact from the pushed commit.

Real SMTP credentials, sending-domain ownership, SPF, DKIM, DMARC, provider reputation/quotas and delivery into production mailboxes were **not configured or verified**. Configure these before deploying; completely absent SMTP settings leave new sign-ins unavailable while existing sessions continue normally. No production users were created or changed. Physical iOS/Android and live-provider delivery were not tested. Email OTP is not phishing-resistant. Synthetic short workload measurements are not a production SLA.

## Significant module ownership

- Backend identity/session/bootstrap: `backend/src/auth.rs`, `auth/otp.rs`, `auth/mail.rs`, `api.rs`, `administration.rs`, `config.rs`, `main.rs`.
- Durable security and recovery: migration 10, `db.rs`, `credentials.rs`, `key_operations.rs`, `recovery.rs`; existing refresh logic is preserved.
- Frontend identity: `LoginPage.tsx`, `AuthProvider.tsx`, `auth-context.ts`, `auth-service.ts`, `email.ts`; administration `UserForm.tsx`/`models.ts`; all five auth/administration locale catalogs.
- Deployment/operator integration: `.env.example`, `docker-compose.yml`, optional `docker-compose.smtp.example.yml`, `Makefile`, `tools/bootstrap.py`; no second production service/image.
- Verification: dedicated OTP/mail and recovery regressions, controlled SMTP helper, real HTTP/browser/image/Compose/capacity/MCP harnesses and existing workflow fixtures.

<details>
<summary>Complete changed-file inventory</summary>

- [.env.example](../.env.example)
- [Cargo.lock](../Cargo.lock)
- [Makefile](../Makefile)
- [README.md](../README.md)
- [backend/Cargo.toml](../backend/Cargo.toml)
- [backend/examples/runtime-fixture.rs](../backend/examples/runtime-fixture.rs)
- [backend/examples/smtp_fixture.inc](../backend/examples/smtp_fixture.inc)
- [backend/migrations/sqlite/000010_email_otp.sql](../backend/migrations/sqlite/000010_email_otp.sql)
- [backend/src/administration.rs](../backend/src/administration.rs)
- [backend/src/api.rs](../backend/src/api.rs)
- [backend/src/auth.rs](../backend/src/auth.rs)
- [backend/src/auth/mail.rs](../backend/src/auth/mail.rs)
- [backend/src/auth/mail/tests.rs](../backend/src/auth/mail/tests.rs)
- [backend/src/auth/otp.rs](../backend/src/auth/otp.rs)
- [backend/src/auth/otp/tests.rs](../backend/src/auth/otp/tests.rs)
- [backend/src/auth/refresh.rs](../backend/src/auth/refresh.rs)
- [backend/src/clients.rs](../backend/src/clients.rs)
- [backend/src/config.rs](../backend/src/config.rs)
- [backend/src/credentials.rs](../backend/src/credentials.rs)
- [backend/src/db.rs](../backend/src/db.rs)
- [backend/src/key_operations.rs](../backend/src/key_operations.rs)
- [backend/src/main.rs](../backend/src/main.rs)
- [backend/src/mcp/tests.rs](../backend/src/mcp/tests.rs)
- [backend/src/operations/tests.rs](../backend/src/operations/tests.rs)
- [backend/src/recovery.rs](../backend/src/recovery.rs)
- [backend/src/recovery_tests.rs](../backend/src/recovery_tests.rs)
- [backend/src/testing.rs](../backend/src/testing.rs)
- [backend/tests/http_smoke.py](../backend/tests/http_smoke.py)
- [docker-compose.smtp.example.yml](../docker-compose.smtp.example.yml)
- [docker-compose.yml](../docker-compose.yml)
- [frontend/e2e/auth.spec.ts](../frontend/e2e/auth.spec.ts)
- [frontend/e2e/controls.spec.ts](../frontend/e2e/controls.spec.ts)
- [frontend/e2e/finance.spec.ts](../frontend/e2e/finance.spec.ts)
- [frontend/e2e/fixtures.sql](../frontend/e2e/fixtures.sql)
- [frontend/e2e/mcp.spec.ts](../frontend/e2e/mcp.spec.ts)
- [frontend/e2e/operations.spec.ts](../frontend/e2e/operations.spec.ts)
- [frontend/e2e/otp.ts](../frontend/e2e/otp.ts)
- [frontend/e2e/refinement.spec.ts](../frontend/e2e/refinement.spec.ts)
- [frontend/e2e/ui-polish.spec.ts](../frontend/e2e/ui-polish.spec.ts)
- [frontend/e2e/websites.spec.ts](../frontend/e2e/websites.spec.ts)
- [frontend/scripts/check-runtime-security.mjs](../frontend/scripts/check-runtime-security.mjs)
- [frontend/scripts/measure-performance.mjs](../frontend/scripts/measure-performance.mjs)
- [frontend/scripts/otp-fixture.d.mts](../frontend/scripts/otp-fixture.d.mts)
- [frontend/scripts/otp-fixture.mjs](../frontend/scripts/otp-fixture.mjs)
- [frontend/scripts/service-worker.test.mjs](../frontend/scripts/service-worker.test.mjs)
- [frontend/src/features/administration/AdministrationFlow.test.tsx](../frontend/src/features/administration/AdministrationFlow.test.tsx)
- [frontend/src/features/administration/UserForm.tsx](../frontend/src/features/administration/UserForm.tsx)
- [frontend/src/features/administration/models.ts](../frontend/src/features/administration/models.ts)
- [frontend/src/features/administration/service.test.ts](../frontend/src/features/administration/service.test.ts)
- [frontend/src/features/auth/AuthFlow.test.tsx](../frontend/src/features/auth/AuthFlow.test.tsx)
- [frontend/src/features/auth/AuthIdle.test.tsx](../frontend/src/features/auth/AuthIdle.test.tsx)
- [frontend/src/features/auth/AuthProvider.tsx](../frontend/src/features/auth/AuthProvider.tsx)
- [frontend/src/features/auth/LoginPage.tsx](../frontend/src/features/auth/LoginPage.tsx)
- [frontend/src/features/auth/auth-context.ts](../frontend/src/features/auth/auth-context.ts)
- [frontend/src/features/auth/auth-service.test.ts](../frontend/src/features/auth/auth-service.test.ts)
- [frontend/src/features/auth/auth-service.ts](../frontend/src/features/auth/auth-service.ts)
- [frontend/src/features/auth/email.ts](../frontend/src/features/auth/email.ts)
- [frontend/src/features/operations/BrowserAlerts.test.tsx](../frontend/src/features/operations/BrowserAlerts.test.tsx)
- [frontend/src/i18n/locales/de/administration.json](../frontend/src/i18n/locales/de/administration.json)
- [frontend/src/i18n/locales/de/auth.json](../frontend/src/i18n/locales/de/auth.json)
- [frontend/src/i18n/locales/en/administration.json](../frontend/src/i18n/locales/en/administration.json)
- [frontend/src/i18n/locales/en/auth.json](../frontend/src/i18n/locales/en/auth.json)
- [frontend/src/i18n/locales/fr/administration.json](../frontend/src/i18n/locales/fr/administration.json)
- [frontend/src/i18n/locales/fr/auth.json](../frontend/src/i18n/locales/fr/auth.json)
- [frontend/src/i18n/locales/ro/administration.json](../frontend/src/i18n/locales/ro/administration.json)
- [frontend/src/i18n/locales/ro/auth.json](../frontend/src/i18n/locales/ro/auth.json)
- [frontend/src/i18n/locales/tr/administration.json](../frontend/src/i18n/locales/tr/administration.json)
- [frontend/src/i18n/locales/tr/auth.json](../frontend/src/i18n/locales/tr/auth.json)
- [notes/architecture.md](../notes/architecture.md)
- [notes/authentication-delivery.md](../notes/authentication-delivery.md)
- [notes/authentication.md](../notes/authentication.md)
- [notes/domains.md](../notes/domains.md)
- [notes/frontend.md](../notes/frontend.md)
- [notes/mcp.md](../notes/mcp.md)
- [notes/operations.md](../notes/operations.md)
- [tools/bootstrap.py](../tools/bootstrap.py)
- [tools/mcp-client/Cargo.lock](../tools/mcp-client/Cargo.lock)
- [tools/otp_fixture.py](../tools/otp_fixture.py)
- [tools/test-browser.py](../tools/test-browser.py)
- [tools/test-capacity.py](../tools/test-capacity.py)
- [tools/test-compose.py](../tools/test-compose.py)
- [tools/test-container.py](../tools/test-container.py)
- [tools/test-mcp.py](../tools/test-mcp.py)
- [tools/test-startup.py](../tools/test-startup.py)

</details>
