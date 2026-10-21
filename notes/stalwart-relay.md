# Roisey Else — Private Stalwart SMTP Relay

## Security contract

Authenticated SMTP remains the default. `SMTP_AUTH_MODE=trusted_relay` deliberately omits SMTP AUTH, requires verified STARTTLS or implicit TLS, rejects all credential settings, and requires an exact RFC1918 IPv4 destination in `SMTP_RELAY_IP`. TCP connects to that pinned address while TLS verifies `SMTP_HOST`; DNS cannot redirect the accountless transport. This does not authenticate Else to Stalwart: the dedicated Docker network and Stalwart's genuine source-IP/listener/TLS/envelope policies supply that authorization. Docker daemon administrators and anyone able to replace/attach containers or reuse the source address are trusted operators. If that boundary cannot be assured, retain authenticated SMTP.

Only the transport/configuration changes. The encrypted bounded outbox, one asynchronous worker, timeouts, OTP lifetime/digests/attempt limits, atomic sessions, refresh cookies, RBAC and data remain unchanged. No production deployment, Stalwart modification or external test email is authorized by this implementation.

The production Stalwart installation is not accessible from this workspace. Version-specific settings are verified against the isolated upstream version identified below; they must not be applied to another version without checking its schema and behavior. Existing listener and policy objects must be exported/preserved before an operator edits them. Never replace production-wide settings with a fresh test configuration.

## 1. Identify the server and preserve its configuration

These are operator instructions; the implementation does not execute them on production. Record the current image digest, listener bindings, network memberships, public port mappings, policy exports and supported mail-server backup before any change:

```sh
docker inspect "$STALWART_CONTAINER" --format '{{.Config.Image}} {{json .Config.Entrypoint}}'
docker exec "$STALWART_CONTAINER" /usr/local/bin/stalwart --version
docker inspect "$STALWART_CONTAINER" --format '{{json .NetworkSettings.Networks}}'
docker inspect "$STALWART_CONTAINER" --format '{{json .HostConfig.PortBindings}}'
docker network ls
docker network inspect $(docker network ls --quiet)
ip -4 route show
```

The binary path above is verified for the official **0.16.27** image. For a different image, identify its documented binary first. This guide's registry JSON, property names and ordered expression maps are verified against [Stalwart 0.16.27, commit aa47d8ef7bfba7200d3293198ac2592747b20e73](https://github.com/stalwartlabs/stalwart/tree/aa47d8ef7bfba7200d3293198ac2592747b20e73). The isolated test image is `stalwartlabs/stalwart@sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c`. This is not a recommendation to upgrade your server. **For another version, retain authenticated SMTP until its matching schema/policies have been reviewed. Do not paste legacy TOML or these JSON objects into an incompatible release.**

Relevant upstream contracts: [registry schema](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/registry/src/schema/structs.rs), [connection-time parameters](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/smtp/src/core/params.rs), [MAIL](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/smtp/src/inbound/mail.rs), [RCPT](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/smtp/src/inbound/rcpt.rs), [genuine expression variables](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/smtp/src/inbound/session.rs), and [numeric-key ordered lists](https://github.com/stalwartlabs/stalwart/blob/aa47d8ef7bfba7200d3293198ac2592747b20e73/crates/registry/src/types/list.rs).

## 2. Provision one dedicated internal network

Choose an unused RFC1918 subnet after checking **all** existing Docker networks, host/VPN routes and operational reservations. A small `/29` is sufficient; no example CIDR is assumed available. Reserve distinct stable addresses for the bridge gateway, Else and Stalwart. Do not grant the subnet relay rights.

Set these nonsecret deployment values in both projects' protected deployment configuration. Replace every marker; they are deliberately invalid placeholders:

```dotenv
ELSE_MAIL_NETWORK=else-mail-internal
ELSE_MAIL_CIDR=REPLACE_WITH_UNUSED_PRIVATE_CIDR
ELSE_MAIL_GATEWAY=REPLACE_WITH_BRIDGE_GATEWAY
ELSE_MAIL_APP_IP=REPLACE_WITH_ELSE_PRIVATE_IPV4
ELSE_MAIL_STALWART_IP=REPLACE_WITH_STALWART_PRIVATE_IPV4
ELSE_MAIL_TLS_HOST=REPLACE_WITH_EXISTING_CERTIFICATE_DNS_NAME
ELSE_MAIL_SENDER=REPLACE_WITH_AUTHORIZED_SENDER_ADDRESS
```

After review and production change authorization, the operator provisions the external bridge once:

```sh
docker network create --driver bridge --internal \
  --subnet "${ELSE_MAIL_CIDR:?Select a conflict-free subnet}" \
  --gateway "${ELSE_MAIL_GATEWAY:?Select its gateway}" \
  "${ELSE_MAIL_NETWORK:?Set the dedicated network name}"
```

An external Compose network must be created with `--internal` here; `external: true` does not make an existing network internal. Attach only Else and Stalwart. Keep Stalwart's existing networks for normal inbound/outbound mail and Else's existing network for HTTPS ingress. Otherwise `internal` isolation would also remove necessary internet delivery.

Use [Else's optional overlay](../docker-compose.stalwart.example.yml) with its existing Compose file. In the **separate** Stalwart project use [this network-only overlay](../examples/stalwart-relay/stalwart.compose.yml), changing its `stalwart` service key to the actual existing service name. Both refer to the same external network. They add no image, volume or port. Inspect the effective Compose configurations before a reviewed recreation: preserve every pre-existing explicit network; the examples retain the ordinary implicit `default` network. Do not merge the applications into a single project, remove volumes or run `down --volumes`.

Remove the example's `default: {}` entry for a service that currently uses only explicit networks and is not a member of its project's default network. Keep its original explicit networks inherited from the base configuration. This avoids adding an unnecessary network or dropping the implicit one; only the dedicated bridge should be a new membership.

Stalwart's dedicated address must exist **before** the listener binds. Stage the network attachment first while Else remains in credentials mode, then configure/test the listener, and only afterward switch Else's SMTP mode. Docker daemon/container-network attachment privileges are part of the trust boundary: anyone able to take Else's IP can impersonate its network identity. An IP-based relay is not cryptographic client authentication.

## 3. Add the listener and scoped policies

In authenticated Stalwart administration, export the full current `MtaStageAuth`, `MtaStageMail`, `MtaStageRcpt`, `MtaStageData` and `MtaInboundSession` singleton objects, retaining their IDs/state and all original expressions. In 0.16.27 the registry API exposes `x:<ObjectType>/get` through the existing administrative JMAP endpoint. Preserve the complete `list` objects from those responses; assemble a private JSON document mapping each type to its singleton object. Expression `match` values are **objects keyed by numeric strings**, not arrays.

Generate a local review artifact from that export:

```sh
umask 077
python3 tools/stalwart-relay-policy.py --version 0.16.27 \
  --else-ip "$ELSE_MAIL_APP_IP" --stalwart-ip "$ELSE_MAIL_STALWART_IP" \
  --sender "$ELSE_MAIL_SENDER" \
  < /absolute/private/current-mta-policy.json \
  > /absolute/private/proposed-else-relay-policy.json
```

The generator performs **no network request or deployment**. It refuses unsupported versions, public/broad/loopback IP identities, duplicate relay rules, incomplete expression exports and unsafe sender interpolation. It emits property-only singleton updates plus two new objects. Existing expression branches/fallbacks remain in their numeric order after the new first branch; unrelated object properties are omitted from updates. Numeric match keys are renumbered to prepend the rule. Review the diff and recheck the original state before manually applying through the installed administrative editor/API. Never copy the test harness's `baseline()` settings over live configuration.

If a singleton has never been persisted and its `get` result is empty, use the installed version's administrative editor to inspect and save its effective current settings unchanged, then export that object. The generator deliberately refuses to guess missing production defaults.

The exact generated behavior is:

| Object/property | New first branch, only when `listener = 'else-relay'` | Other listeners |
| --- | --- | --- |
| `MtaStageAuth.require` | `remote_ip != '<exact Else IP>'` | Original expression |
| `MtaStageAuth.saslMechanisms` | `0` (no AUTH on this listener) | Original expression |
| `MtaStageMail.isSenderAllowed` | `remote_ip = '<exact Else IP>' && is_tls && sender = '<configured address>'` | Original expression |
| `MtaStageRcpt.allowRelaying` | The same exact IP/TLS/sender predicate | Original expression, including existing authenticated relay rights |
| `MtaStageRcpt.maxRecipients` | `1` | Original expression |
| `MtaStageData.maxMessages` | `1` | Original expression |
| `MtaStageData.maxMessageSize` | `65536` bytes | Original expression |
| `MtaInboundSession.maxDuration` | `60s` | Original expression |
| `MtaInboundSession.timeout` | `15s` | Original expression |
| `MtaInboundSession.transferLimit` | `262144` bytes | Original expression |

AUTH requirements are evaluated at connection time, before STARTTLS. Putting `is_tls` in the AUTH exemption would leave a legitimate STARTTLS client required to authenticate. The exemption therefore identifies only the listener/exact source; **MAIL and RCPT independently require actual TLS** before submission/relay is possible. AUTH stays disabled on the dedicated listener. An authenticated session cannot bypass its strict first RCPT branch. A sender's EHLO, reverse DNS, HTTP forwarding headers and Docker hostname never grant relay rights.

The new `NetworkListener` binds **only** `<Stalwart dedicated IPv4>:10025`, with `protocol: smtp`, `useTls: true`, `tlsImplicit: false`, a 10,000ms handshake deadline and `maxConnections: 2`. It uses a nonempty `overrideProxyTrustedNetworks` map containing only `::1/128`. In 0.16.27 an empty override inherits global trust; the IPv6-loopback selector instead cannot match any peer on this explicitly IPv4-bound listener. Upstream `IpAddrOrMask.matches` maps an IPv4 peer to its IPv6-mapped address, which can never equal `::1`. Consequently no actual source is a trusted PROXY sender. Do not replace it with Else's IP, a bridge gateway, an assignable IPv4 sentinel or a shared subnet. Forged PROXY lines fail even from the authorized Else source, and authorization uses the genuine TCP peer.

The new `MtaInboundThrottle` matches only this listener, keys by both listener and `remoteIp`, and permits 20 connections per 60,000ms. Together with one message per session, it also bounds submissions across reconnects; changing sender/recipient does not reset the budget. Else's stricter independent email/IP/global OTP budgets remain in effect. The 64KiB cap covers the entire email, not only the code. Message-count enforcement occurs at DATA, so a second MAIL command alone is not proof of a second accepted message.

Use Stalwart's existing verified certificate for `ELSE_MAIL_TLS_HOST`; renew it through existing certificate management. It must be loaded for this listener, match that DNS name and chain to the scratch image's normal CA roots. No insecure certificate bypass or new production CA is provided. Do not change spam, SPF/DKIM/DMARC checks, sender matching or the existing public/submission listener objects. **Port 25's current binding, publishing and unauthenticated-relay prohibition remain unchanged.** No host `ports`, reverse proxy, Cloudflare, firewall forward or public DNS entry may expose port 10025.

## 4. Configure Else

```dotenv
SMTP_AUTH_MODE=trusted_relay
SMTP_HOST=mail.example.com
SMTP_RELAY_IP=REPLACE_WITH_STALWART_PRIVATE_IPV4
SMTP_PORT=10025
SMTP_SECURITY=starttls
SMTP_FROM_ADDRESS=noreply@example.com
SMTP_FROM_NAME=Roisey Else
SMTP_TIMEOUT_SECONDS=10
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_PASSWORD_FILE=
```

The hostname/domain above are placeholders. The Else overlay supplies the selected values automatically. Do not combine it with the credential-file overlay. Every nonempty credential setting in trusted-relay mode is an error, including an unused password-file path. `SMTP_RELAY_IP` must be one exact RFC1918 IPv4, not a hostname/CIDR, public address, IPv6, loopback, link-local or CGNAT address. TCP is pinned to that IP, while TLS verifies `SMTP_HOST`; the Docker DNS alias aids correct naming/diagnostics and is not a trust grant. No DNS rebinding path is used by this transport. STARTTLS cannot downgrade. Implicit verified TLS remains supported by Else if the corresponding independently reviewed listener uses it; the provided Stalwart example/test uses STARTTLS.

`SMTP_AUTH_MODE` defaults to `credentials` when absent/blank. `SMTP_RELAY_IP` has no default and is forbidden in credentials mode. Trusted relay requires an **explicit port**; credentials mode retains default 587. Other defaults remain mandatory STARTTLS, sender name Roisey Else and 10-second bounded delivery. Fully blank SMTP configuration still disables new sign-ins safely; malformed/partial settings fail startup. No schema or account migration is added by the relay feature.

## 5. Verify before enabling live sign-ins

```sh
docker network inspect "$ELSE_MAIL_NETWORK" --format '{{.Internal}} {{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}'
docker inspect "$ELSE_CONTAINER" --format '{{json .NetworkSettings.Networks}}'
docker inspect "$STALWART_CONTAINER" --format '{{json .NetworkSettings.Ports}}'
docker inspect "$ELSE_CONTAINER" --format '{{json .NetworkSettings.Ports}}'
```

Confirm `Internal=true`, precisely two intended members, the reserved source/destination IPs, no host mapping for 10025, no SMTP port from Else, and unchanged public 25 mappings. In Stalwart administration confirm the live listener address/TLS configuration, all compiled policy expressions, throttle and active certificate; a configuration file edit alone does not prove an active listener.

The Else scratch image has no shell or diagnostic utilities. A disposable, pinned Python diagnostic can inspect its namespace without altering it. For example, set `RELAY_DIAGNOSTIC_IMAGE=python@sha256:848ba4413eb897e225159b8fc1b02094576cbae4aa73fc13142608ae2c8c0e32`, then:

```sh
docker run --rm --network "container:$ELSE_CONTAINER" "$RELAY_DIAGNOSTIC_IMAGE" \
  python -c 'import socket,sys; print(socket.getaddrinfo(sys.argv[1],10025,type=socket.SOCK_STREAM))' \
  "$ELSE_MAIL_TLS_HOST"

docker run --rm --network "container:$ELSE_CONTAINER" "$RELAY_DIAGNOSTIC_IMAGE" \
  python -c 'import smtplib,ssl,sys; c=smtplib.SMTP(sys.argv[1],10025,timeout=10); c.ehlo(); c.starttls(context=ssl.create_default_context()); c.ehlo(); assert not c.has_extn("auth"); print(c.noop()[0]); c.quit()' \
  "$ELSE_MAIL_TLS_HOST"
```

The second command verifies the real certificate/hostname, sends no AUTH and sends no email. Use a vetted diagnostic image with normal current CA roots; do not disable verification to make this pass. For direct peer evidence, inspect Stalwart's connection metadata, or on its host use `nsenter -t <Stalwart host PID from docker inspect> -n tcpdump -nn -i any 'tcp dst port 10025 and tcp[tcpflags] & tcp-syn != 0'` during that probe. Capture SYN metadata only, never SMTP DATA or OTP mail. The source must be the reserved Else address, not the gateway/proxy. Confirm external ingress/firewall exposure independently; no public-internet scan was performed by this implementation.

Run negative checks in a controlled staging clone before production: an unrelated shared-network container, a third source deliberately attached to the test private network, a forged sender/null sender, plaintext submission, forged PROXY line, public port 25 external-recipient relay, second recipient, second message, oversize DATA, excessive concurrency and reconnect rate must fail. Do not attach untrusted test containers to the live authorized network or send arbitrary internet email. Preserve ordinary inbound mail and authenticated submission through the existing listener.

Finally, use one existing authorized Else account/mailbox controlled by the operator: request a code, confirm real inbox receipt, sign in and verify that replay fails. Check sender alignment/DKIM/DMARC in that received message without sharing its code. Else's `auth_otp_delivery_sent`/outbox `sent` means **SMTP handoff accepted**, not inbox delivery. Full code/session/replay tests use protected synthetic fixtures; live inbox delivery is a separate deployment check.

## 6. Sender domain, troubleshooting and rollback

Accountless SMTP does not provision or authorize a sending domain. Stalwart must already be authorized for the domain in both the SMTP envelope sender and RFC 5322 From (Else uses the configured address for both). Configure valid SPF for Stalwart's actual outbound IP, DKIM signing and aligned DMARC; verify domain ownership, outbound port-25/provider connectivity, appropriate DNS/PTR/reputation and bounce processing. A real mailbox or alias may be needed for replies/bounces, but is not an SMTP login requirement. Public inbound port 25 publication does not establish outbound connectivity or external inbox acceptance.

For startup refusal, check mode, forbidden leftover credentials, exact RFC1918 IP, sender syntax and TLS settings. For failed sends, check network members/routes, certificate name/expiry/chain, Stalwart's compiled rules, peer metadata, quotas and its queue using protected administration. Else logs fixed redacted events only; never paste raw message/provider diagnostics, SMTP secrets or a verification code. Stalwart unavailability does not block the HTTP request: the bounded outbox worker invalidates failed/ambiguous sends, clears temporary ciphertext and keeps ordinary cooldown/resend semantics. Already accepted mail cannot be recalled; invalidated/expired/superseded codes remain unusable.

To revert, first restore the previous working Else credentials configuration: `SMTP_AUTH_MODE=credentials`, unset `SMTP_RELAY_IP`, restore verified host/port/TLS and the protected credential file. Remove the relay overlay and confirm sign-in handoff using the existing authenticated route. Only then remove the new Stalwart listener/throttle and restore the saved singleton expressions under a reviewed change. Detach the private endpoints/network only after verifying no remaining users. Preserve normal networks, public ports, mail queues, all data volumes and every existing certificate/account. No downgrade or data reset is needed.

## Verification and deployment boundary

`make test-stalwart IMAGE=<exact built Else image>` runs the offline preservation/validation tests and a pinned disposable Stalwart instance with independent private/shared networks. The SMTP diagnostic checks never target a production server and use reserved `.test`/`.invalid` identities. Synthetic administrator credentials and test-only certificate material are private, temporary and cleaned up with owned containers/networks. The normal scratch image/CA bundle is unchanged; only that fixture mounts its generated trusted certificate. Actual-image OTP handoff asserts encrypted-queue completion without creating a session. This gate is included before CI image publication.

The source implementation adds two configuration variables, optional network-only deployment overlays, a version-guarded offline policy generator, TLS/negative/integration tests and this guide. It creates no SMTP service account or new production service/image. Existing local SMTP test fixtures and authenticated SMTP remain supported. Production Stalwart settings, network/source identity, public exposure, certificate renewal, DNS authenticity and real external mailbox delivery require the operator's review and verification; they have not been applied or certified by repository tests.
