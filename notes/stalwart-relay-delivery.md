# Private Stalwart relay delivery — 2026-10-21

Repository `theroisey/else`, branch `main`, baseline `1efe1a22a0c64605748494a02fa9f09396ef7179`. The associated commit identifies this implementation. No production deployment, mail-server change, network attachment or customer-data mutation was performed.

## Implementation and defaults

`backend/src/auth/mail.rs` adds explicit `SMTP_AUTH_MODE=trusted_relay`. Absent/blank mode retains `credentials`. New `SMTP_RELAY_IP` has no default: trusted relay requires an exact RFC1918 IPv4 and an explicitly configured SMTP port; credentials mode forbids that IP setting. Trusted relay rejects every nonempty username, password and password-file setting and all plaintext/opportunistic transports. The socket connects directly to the pinned private IP; mandatory STARTTLS/implicit TLS still verifies the DNS name in `SMTP_HOST` using the ordinary native CA roots. No AUTH exchange is attempted. Other SMTP defaults and local loopback fixtures remain compatible.

The encrypted bounded outbox, asynchronous worker, delivery deadlines, message templates, account eligibility, OTP security, atomic session creation, refresh families and RBAC remain unchanged. No dependency, frontend, database schema or data migration is introduced.

## Server authorization and deployment examples

The [setup guide](stalwart-relay.md) supplies version identification, network/subnet/source checks, the two separate-project Compose overlays, TLS and sender-domain prerequisites, negative verification, troubleshooting and rollback. `docker-compose.stalwart.example.yml` extends the existing Else service; `examples/stalwart-relay/stalwart.compose.yml` changes only the existing Stalwart service's networking. They retain existing image/storage/security settings and add no SMTP host port. The pre-created external bridge must be internal and have only the intended two members.

`tools/stalwart-relay-policy.py` is an offline **0.16.27-only** review-artifact generator. It prepends narrowly scoped branches to exported live expressions and preserves their original ordered branches/fallbacks, emits only changed singleton properties, and adds the private listener and its throttle. It makes no API calls. Actual Stalwart tests bind only the dedicated IP and enforce listener + genuine source IP + TLS + exact envelope sender. AUTH is exempted by source/listener at connection time, with TLS enforced independently at MAIL and RCPT. Other listeners retain their original authorization, including ordinary authenticated submission and public-port relay denial. Limits cover recipients, messages, message size, transfer bytes, time, connection concurrency and reconnect rate. Global proxy trust is not inherited by the private listener.

## Executed verification

| Check | Result |
| --- | --- |
| `make check` and final Rust regression | Passed: lint/types/format/Clippy, **485 frontend tests / 53 files**, **136 Rust tests** |
| Focused SMTP tests | **8 passed**, including configuration matrices, verified STARTTLS, omitted AUTH despite advertisement, preserved credential AUTH, certificate/hostname failure, downgrade, bounded timeout, lost handoff and invalidation without session creation |
| Offline policy preservation/validation | **3 passed** |
| Service-worker regression | **5 passed** |
| Publication regression and official pinned actionlint | **11 passed**, workflow validation passed |
| Separate-project Compose configuration comparison | Passed: one Else service, unchanged image/volume/ports/runtime protections; original Stalwart public-25 mapping and existing explicit network retained |
| Static musl production build | Passed with the pinned Rust toolchain |
| Final exact-image startup refusals | **11 passed**, including relay credentials, public destination and plaintext rejection before Redis starts |
| Final exact-image runtime/recovery | Passed: real HTTP/static/gzip/auth/finance, nonroot PID 1/owned Redis, read-only root, persistence, both shutdown signals, online backup and fresh-key restore |
| Pinned actual Stalwart 0.16.27 | **15 checks passed**: valid credential-free TLS handoff, forged/null sender denial, plaintext denial, wrong source, forged PROXY, recipient/message/advertised-size limits, oversize actual DATA, concurrency, shared-interface exclusion, public-listener relay denial, ordinary submission AUTH requirement, authenticated submission, reconnect rate, and actual Else encrypted OTP handoff without session creation |
| Final exact-image browser workflows | **39 passed**; real login/refresh/revocation, permissions, financial and operational workflows, all themes/locales, mobile, cache and CSP |
| Final exact-image Compose and MCP | Passed: actual production single-service Compose/restart/recovery and independent rmcp 3.5.1 clients for both supported protocol eras |
| Final exact-image capacity rehearsal | Passed: **500 clients, 100 OTP-authenticated concurrent users, 3,000 requests / 100 writes**, 2 CPUs / 256MiB. Read P95 **546.77ms**, write P95 **364.23ms**, 20-user financial burst P95 **1,515.23ms**, observed memory **30.72MiB** |

The test harness creates disposable private/shared networks, fresh storage, generated TLS material and a synthetic administrative identity. Diagnostic clients receive no server key or administrative secret, except the separate authenticated-submission case's own protected temporary credential. No Stalwart SMTP service account is created. SMTP recipients are reserved `.invalid` fixture identities, and no real external mailbox delivery is tested. CLI arguments and retained evidence contain no verification codes or generated administrator secrets. CI runs the same isolated Stalwart gate against its exact built image before publication.

## Artifact evidence and operating limits

Final local image: `sha256:b58a1bdc21078d29696d155cd4b5fe904c4c0b887218b4d36f3ee27fc4bc6727`, **42,345,736 bytes**. Static application SHA-256: `3c537e166d3087c2e3e3b82b8bbce66590985b5ee06760911ad99fc32033327a`. The image is labeled `stalwart-relay-local-worktree`; local evidence does not establish registry publication or production deployment. Check the pushed commit's actual CI run for its separately built, tested and attested artifact.

The user's live Stalwart version/configuration is inaccessible here. The guide is verified against upstream 0.16.27/source `aa47d8ef7bfba7200d3293198ac2592747b20e73` and image `sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c`; another version requires a matching schema review or the existing authenticated SMTP fallback. The generator refuses other versions. Public SMTP tests exercise a controlled clone's public-listener policy from another network; they are not an internet scan or proof of the live host firewall. No production port-25 mapping or policy was changed.

Private IP ownership is network authorization, not cryptographic service authentication. Host/Docker administrators and anyone able to attach/replace the authorized endpoint or reuse its address are trusted. If isolation/source identity cannot be guaranteed, retain authenticated SMTP. Domain ownership, SPF/DKIM/DMARC, outbound connectivity, PTR/reputation, bounce handling, certificate renewal and delivery into real user inboxes require operator verification. SMTP acceptance means handoff, not inbox arrival.

Capacity results are a short synthetic rehearsal, not a production mail-delivery or application SLA. Live Stalwart policies, external connectivity and physical devices were not verified. Repository CI performs its own build and full publication gates after push; local results do not imply that this new commit's remote run has already passed.

## Operator setup checklist

1. Identify the installed Stalwart version; export/back up its current configuration and preserve public-25 mappings.
2. Choose a conflict-free internal subnet and exact endpoints; review both Compose overlays against all existing network memberships.
3. Provision the internal external bridge and Stalwart endpoint under an authorized rollout; retain normal mail/ingress networks.
4. Review/apply the version-compatible listener and generated scoped policy patch, preserving original fallbacks and certificate handling.
5. Verify the observed source, TLS hostname/certificate, two-member topology, private listener binding, no host 10025 mapping, and staging negative tests.
6. Enable explicit Else relay mode without credentials, then verify one controlled real email-code sign-in and replay denial. Keep the documented authenticated route available for rollback.

## Modified files

- [.env.example](../.env.example)
- [.github/workflows/ci.yml](../.github/workflows/ci.yml)
- [Makefile](../Makefile)
- [README.md](../README.md)
- [backend/src/auth/mail.rs](../backend/src/auth/mail.rs)
- [backend/src/auth/mail/tests.rs](../backend/src/auth/mail/tests.rs)
- [backend/src/auth/mail/tests/tls.rs](../backend/src/auth/mail/tests/tls.rs)
- [docker-compose.stalwart.example.yml](../docker-compose.stalwart.example.yml)
- [docker-compose.yml](../docker-compose.yml)
- [examples/stalwart-relay/stalwart.compose.yml](../examples/stalwart-relay/stalwart.compose.yml)
- [notes/architecture.md](../notes/architecture.md)
- [notes/authentication-delivery.md](../notes/authentication-delivery.md)
- [notes/authentication.md](../notes/authentication.md)
- [notes/operations.md](../notes/operations.md)
- [notes/stalwart-relay-delivery.md](../notes/stalwart-relay-delivery.md)
- [notes/stalwart-relay.md](../notes/stalwart-relay.md)
- [tools/otp_fixture.py](../tools/otp_fixture.py)
- [tools/stalwart-relay-policy.py](../tools/stalwart-relay-policy.py)
- [tools/test-stalwart-policy.py](../tools/test-stalwart-policy.py)
- [tools/test-stalwart-relay.py](../tools/test-stalwart-relay.py)
- [tools/test-startup.py](../tools/test-startup.py)
