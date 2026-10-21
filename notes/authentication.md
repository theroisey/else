# Passwordless authentication policy

This is the implementation security contract for the email-code migration. Password authentication is retired, including the legacy login endpoint. Existing session/refresh families retain their expiry and revocation rules; immutable user IDs, grants and financial history remain unchanged. The legacy non-null password column receives an inert `!passwordless` marker for new users and is never consulted by authentication. Removing the column needs a separately verified schema evolution.

## Protocol and threat model

Only existing active accounts receive mail. Every syntactically valid request receives the same opaque challenge and timing document, including unknown/disabled addresses. Exact Origin, JSON, bounded bodies and an HttpOnly host-only Strict pre-auth nonce protect both steps. The nonce confers no authority. Codes use OS entropy with unbiased rejection sampling, six decimal digits and a default 180-second deadline. A domain-separated HMAC-SHA256 binds the retained key label, challenge, immutable user, authentication purpose and code. Comparison is constant time. The admitted SQLite writer consumes a delivered challenge and creates the ordinary session, refresh generation and typed session audit atomically. Active account identity is rechecked there. Five failed guesses exhaust a challenge. A replacement invalidates previous pending codes; successful verification invalidates all remaining codes for that account. A developer/operator never receives a production code through an API or log.

Durable sliding-window budgets apply independently to normalized-email requests (3/15 minutes), genuine direct-peer requests (30/15 minutes), global requests (300/15 minutes), peer verification attempts (100/15 minutes) and global verification attempts (1000/15 minutes). A 60-second per-email cooldown also applies to unknown identities. Forwarded headers are ignored. SQLite stores only fixed-length pseudonymous counter keys and bounded events; expired rows are pruned in bounded batches. Global limits cap anonymous storage and work. Rate-limit responses cannot disclose account eligibility. Hosts behind a shared ingress should review direct-peer limits for legitimate capacity; edge identity is not implicitly trusted.

## Delivery and keys

A bounded, short-lived encrypted SQLite outbox hands mail to one in-process asynchronous SMTP worker. No network operation occurs inside a transaction or a user request. Payload encryption uses the retained application keyring and its irreversible nonce-reservation budget, with separate authentication-purpose associated data. First authentication use of a key is audited; anonymous quota increments remain durable accounting rather than creating one retained business audit per request. Existing provider-reservation audits are unchanged. OTP HMAC keys are domain-separated from encryption keys. Keys travel with existing protected backup/restore bundles. Successful or terminal sends remove ciphertext. A claimed send is never retried after an ambiguous SMTP outcome or process restart: its challenge is invalidated, preventing duplicate successful sends. Definitive failures also invalidate the challenge; the user can resend after the ordinary cooldown. Codes are not valid before successful handoff. The worker rechecks eligibility/supersession immediately before transport; mail already accepted by a provider cannot be recalled, and superseded codes remain invalid even if mail arrives late. Delivery has a deadline shorter than code lifetime and bounded queue admission. Restore invalidates every OTP and deletes temporary outbox material before recovered traffic; restored codes must never be resurrected.

SMTP uses verified TLS (implicit TLS or mandatory STARTTLS), protected credential-file support, bounded connect/delivery deadlines and a fixed configured sender. Plain SMTP is allowed only for explicitly configured loopback development fixtures. No real mail delivery or sender DNS authenticity is implied by fixture tests. Operators configure and verify SPF, DKIM, DMARC, sender-domain ownership and provider limits before upgrade. Missing SMTP configuration fails closed for code requests without breaking existing sessions; explicitly malformed/insecure configuration fails startup.

## Identity administration and recovery

Account creation and first-admin bootstrap accept email and display name only. Bootstrap still requires an empty user table. Normal profile editing cannot replace a registered mailbox. Mailbox recovery is a deliberate trusted-operator operation after independent identity/mailbox verification, with current administrator attribution, expected revision and confirmation, session/OTP revocation and an atomic typed audit. There is no anonymous registration, password fallback, bypass code or public mailbox-replacement endpoint. Disablement also invalidates outstanding challenges. Mailbox compromise/phishing can compromise email-code authentication: this is not phishing-resistant authentication; future optional passkey step-up needs a separate reviewed scope.

## Browser and rollout

The login uses native uncontrolled email/code fields, no persistence, no automatic resend on mount, separate strict challenge/session validators, accessible numeric OTP/paste semantics and all five locales. Only loading indicators fade. Auth routes remain no-store and bypass the service worker; old frontend password calls receive a fixed retirement error. No access/refresh/OTP secrets enter query state, analytics, URLs or screenshots. Save open work and close old tabs when adopting the new frontend. Take a supported checkpoint before upgrading and a new schema-compatible checkpoint afterward. There is no automatic downgrade or production deployment in this implementation.

## Deployment configuration

The serving process accepts these settings; none is printed to startup logs:

| Setting | Default / rule |
| --- | --- |
| `SMTP_HOST` | Required configured SMTP hostname; no URL/path |
| `SMTP_PORT` | Credentials default 587; trusted relay requires an explicit port; integer 1–65535 |
| `SMTP_AUTH_MODE` | `credentials` when absent/blank; `trusted_relay` must be deliberately selected |
| `SMTP_RELAY_IP` | Required exact RFC1918 IPv4 in trusted-relay mode, forbidden in credentials mode; no default |
| `SMTP_USERNAME` | Required for production credentials mode; forbidden in trusted-relay mode |
| `SMTP_PASSWORD_FILE` | Credentials mode only: preferred absolute protected 0400/0600, regular single-link, no-follow credential file, max 4096 bytes; runtime UID or root ownership |
| `SMTP_PASSWORD` | Alternative secret injection; mutually exclusive with file. Environment secrets can be inspected by privileged host tooling; avoid committed `.env` credentials |
| `SMTP_FROM_ADDRESS` | Required validated sender address in verified sending domain |
| `SMTP_FROM_NAME` | Roisey Else |
| `SMTP_SECURITY` | `starttls` (mandatory upgrade) or `tls` (implicit TLS, normally port 465); verified certificates, never downgrade |
| `SMTP_TIMEOUT_SECONDS` | 10; range 1–15, whole-send ceiling |
| `AUTH_OTP_LIFETIME_SECONDS` | 180; range 60–300 |
| `AUTH_OTP_COOLDOWN_SECONDS` | 60; range 30–180 |
| `AUTH_OTP_EMAIL_REQUESTS` | 3 per rolling 900 seconds; range 1–10 |
| `AUTH_OTP_PEER_REQUESTS` | 30 per rolling 900 seconds; range 1–300 |
| `AUTH_OTP_GLOBAL_REQUESTS` | 300 per rolling 900 seconds; range 1–500 |

All SMTP fields absent/blank disables delivery and makes new code requests fail closed with 503; existing sessions and operator commands still work. Partial/invalid SMTP configuration refuses startup. Configure sender and credentials before upgrading a live installation; do not deploy a passwordless build without a working mail route. Production requires the exact external HTTPS `AUTH_PUBLIC_ORIGIN` and `AUTH_COOKIE_SECURE=true`; HTTPS startup refuses insecure-cookie mode. The scratch image keeps its distribution trust bundle and Rust-native verified TLS. SMTP is the only new outbound destination and must be permitted by the deployment's egress policy. This implementation does not change a Cloudflare account or a firewall.

Use the optional `docker-compose.smtp.example.yml` overlay to mount a protected password file into the existing service. Set the nonsecret SMTP fields in the host environment or private deployment `.env`, and `SMTP_PASSWORD_HOST_FILE` to the protected host file. For file-backed Compose secrets, prepare source ownership/mode for UID 65532; the application refuses world-readable 0444 defaults. Privileged host operators retain trust authority. No second service/image is required. Alternatively, use your hosting platform's protected environment-secret injection with `SMTP_PASSWORD`. The protected application keyring is provisioned and backed up automatically; SMTP credentials must be recovered through your secret manager, never inserted into application bundles.

Complete provider setup separately: verify sending-domain ownership, SPF authorization, DKIM signing, DMARC policy/alignment and delivery reputation; confirm provider quotas and test arrival in actual user mailboxes. Fixture success does not verify any of these. Never send test codes to arbitrary customer addresses. Behind a shared ingress, the genuine direct peer can be the same for many users; explicitly size `AUTH_OTP_PEER_REQUESTS` for legitimate sign-ins and enforce additional edge limits. Do not trust spoofable `X-Forwarded-For`/`CF-Connecting-IP` headers. Five guesses per challenge, 100 peer verification attempts/15 minutes, 1000 global verification attempts/15 minutes, 100 queued messages and 6000 retained challenges are fixed security bounds.

For an independently administered Stalwart server, [Private Stalwart SMTP Relay](stalwart-relay.md) describes deliberate accountless delivery over a dedicated internal Docker network. Trusted-relay mode rejects every nonempty username/password/password-file setting and plaintext transport, pins TCP to `SMTP_RELAY_IP`, and verifies TLS against the DNS name in `SMTP_HOST`. It never performs SMTP AUTH. Private IP ownership is enforced by Docker and the Stalwart listener/MAIL/RCPT policies, not by this client flag. Keep credentials mode unless those independent controls and the installed Stalwart schema have been verified. No SMTP or sender-domain account is created by the application; existing server domain/signing/bounce arrangements remain operator responsibilities.

For isolated development, `SMTP_SECURITY=none` is accepted only with numeric loopback SMTP and the explicitly insecure loopback application origin. Do not use this in production. The unshipped `runtime-fixture` helper supplies a controlled loopback SMTP sink for native and exact-image tests. It writes synthetic codes only to an owned temporary fixture directory, never application telemetry, CI traces or production assets. Fixtures reset their own rate history between unrelated workflow scenarios; dedicated security tests exercise genuine durable limiting.

## Sign-in and administration

Enter the registered email, select Continue with email, and paste the six-digit code from the message. Codes expire server-side after the configured lifetime, are browser-bound, and cannot be used twice. The masked destination and countdown are informational. A replacement invalidates the prior code. Requesting mail never registers an account or issues a session. Reloading loses only the in-memory challenge; it does not automatically send another message. On a lost verification response, check the current session or sign in again; never replay business mutations.

Create accounts in Users using display name/email, then assign roles independently. Bootstrap accepts bounded stdin JSON `{"email":"owner@example.com","display_name":"Owner"}` through `make bootstrap` or the image's native `bootstrap` command, exactly once on an empty user table. Both owners need separate accounts. No temporary/default passwords exist.

Identity writes and OTP requests apply the established normalization plus the reviewed SMTP address parser, rejecting malformed/empty local parts before queueing. Existing stored addresses are never rewritten: a legacy address that cannot be represented by SMTP needs verified operator recovery, while its preexisting valid sessions keep their normal behavior. Normal profile updates preserve the registered email. To recover a lost mailbox, a trusted host operator must independently verify the person and control of the replacement mailbox using the organization's approved procedure. This is not proof supplied by the application. Save a checkpoint and obtain current user revision/administrator attribution through authorized administration. Feed protected stdin JSON to the published image's existing process:

```sh
docker compose exec -T else /roisey-else recover-email < /absolute/private/recovery-command.json
```

The bounded document requires `actor_id`, `user_id`, `email`, `expected_revision`, and `confirm:true`. The current active attributed administrator must have global `users.manage` and `roles.manage`; an actor ID alone never authenticates an operator. The trusted host boundary supplies operator authority. Recovery changes only the registered email/revision and atomically revokes browser session families, pending codes/mail and delegated OAuth grants, with a safe typed audit. Role assignments, record IDs and business history remain. Protect/remove the input according to local retention policy. Bootstrap cannot recover an initialized installation. If no active authorized administrator remains, stop and use a reviewed organizational recovery procedure; no permanent bypass or unauthenticated replacement API is provided.

## Troubleshooting and ingress

Check fixed events `auth_otp_request`, `auth_otp_delivery_sent`, `auth_otp_delivery_failed`/`email_delivery_failed`, `auth_otp_verification`, `email_queue_failed`, and `email_recovery_failed`. They contain no mailbox, OTP, digest or raw SMTP reply. Successful sessions retain their ordinary attributed audit. Anonymous attempts use bounded security state and safe operational events rather than retained per-attempt business audits. Inspect provider diagnostics through its protected operator console; never paste SMTP credentials or code-bearing messages into issues/logs.

For missing mail: check spam, sender verification, provider quota, outbound SMTP connectivity, exact TLS mode/port and secret file metadata; wait for the normal cooldown before requesting a new code. A failed/ambiguous send invalidates its code. Retrying the scheduler cannot authenticate or duplicate an accepted send. A restart invalidates abandoned sending claims; queued unexpired work can continue, while expired/superseded work is suppressed. Corrupt encrypted payloads are invalidated without blocking later entries. Repeated 429 responses may reflect a shared ingress peer budget or deliberate abuse; investigate before raising bounded policy. Redis never owns these counters. SQLite/key failure cannot produce an authenticated session.

Bypass caching for `/api/v1/auth/*` and preserve Origin and all Set-Cookie headers. The application emits `Cache-Control: no-store`; the service worker does not handle API caching. Authentication POSTs need JSON and exact same-origin checks, not anonymous WAF challenges returning HTML. Scope any necessary Cloudflare challenge exception to the exact hostname/auth paths and demonstrated feature; retain authentication, WAF and edge budgets. Old password bundles receive 410 at `/api/v1/auth/login`; close saved old tabs and reload the current build rather than enabling a fallback. No Cloudflare/DNS/SMTP production setting is changed by this code.

See [delivery evidence and changed-file inventory](authentication-delivery.md) for executed checks and their limits.
