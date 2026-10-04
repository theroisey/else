# Application architecture

Current implemented architecture under [#32](https://github.com/theroisey/else/issues/32). Historical bootstrap decisions remain in their original records. [Production operating procedures](production-readiness.md) define target configuration and separate traffic approval.

## Application shape

The user's 2026-10-05 direction supersedes the earlier external-database distribution under existing #32: the standard distribution packages **React, Go, and PostgreSQL in one image and one supervised container**. One Compose service (`else`), one application port, and one named volume are the installation boundary. Source architecture remains a modular monolith. Go serves assets and `/api/v1` at one origin; a supervised worker consumes durable PostgreSQL jobs inside that container.

The implementation must initialize only an empty PostgreSQL 18 directory, preserve the existing volume and cluster layout, apply pending embedded migrations and reviewed grants before launching API/worker, and stop the complete container on required-process failure. PID 1 reaps children; shutdown drains application processes before PostgreSQL fast shutdown. Database and application processes use distinct unprivileged identities. Only the restricted startup/operator supervisor may provision roles or access owner credentials; HTTP handlers never run DDL. Generated database credentials and the durable encryption keyring remain private on the persistent volume. Loopback PostgreSQL is not published.

Normal patch/application upgrades reuse that volume. PostgreSQL major-version changes, logical restores, encryption-key recovery, and production traffic release remain explicit operating procedures. Never initialize a nonempty unrecognized directory, run multiple PostgreSQL instances on one volume, reuse rewound encryption budgets, or generate replacement keys over unreadable existing encrypted data. The existing interactive-only administrator bootstrap is retained; there is no default account/password. This packaging change introduces no business schema, permission, audit-event, frontend route, or financial-rule change.

The frontend owns presentation, interaction, accessible forms, query state, and client-side validation for usability. It does not own authorization or financial calculations. The backend owns authenticated identity, permissions, client isolation, validation, domain invariants, exact calculations, persistence, and audit writing.

## Backend boundaries

HTTP handlers decode requests, invoke an application service, and encode a stable response. Application services orchestrate permission checks and transactions. Domain rules define state transitions and financial invariants. Database code owns queries, constraints, and transaction primitives. Provider adapters translate external contracts into internal data.

Avoid generic repositories, provider interfaces, or service layers without consumers. Shared boundaries should emerge from a concrete slice rather than a speculative framework.

## API contracts

Business APIs use `/api/v1`. Every implemented endpoint has a documented request/response/error contract shared with its frontend Issue. Collections have bounded pagination; filtering and sorting are explicit. Input validation rejects unsupported values, malformed identifiers, and inappropriate sizes without exposing internal errors.

The [HTTP contract](backend-http.md) defines the error envelope, request ID and health/readiness semantics. [Identity](identity.md) and [authorization](authorization.md) define current-session, CSRF and permission/scope boundaries. Implemented modules include clients, tasks, planning, reminders, collections/payments, immutable pricing, activity/audit, users/roles and the read-only Release Center. GA4 analytics, WooCommerce commerce and Meta marketing have independently authorized report workspaces and audited encrypted manual setup/background synchronization. Provider-specific limitations remain explicit in their synchronization/workspace contracts; reports contain measured observations rather than sample production data.

## Security and client scope

The backend denies access without a valid identity, required permission, and relevant client scope. Roles collect permissions; application code checks permissions rather than role names. Knowing a client or record ID never establishes access.

Session, CSRF, password, rate-limit, and administrator bootstrap behavior follows the reviewed [Issue #8 identity contract](identity.md). [Issue #9](https://github.com/theroisey/else/issues/9) implements global/client scope and delegation rules in the [authorization contract](authorization.md). The bootstrap marker is not an authorization bypass; it is converted into an ordinary role assignment.

Integration credentials remain backend-only. Logs, URLs, frontend bundles, and audit payloads exclude secrets and sensitive payment references. Runtime database access and migration access have explicitly designed privileges.

## Audit and activity

[Issue #7](https://github.com/theroisey/else/issues/7) establishes [append-oriented audit infrastructure](audit-log.md) before business mutations. A successful significant mutation and its audit event share a database transaction. Safe field allowlists govern snapshots and metadata; passwords, tokens, and provider credentials never enter audit records.

User-facing activity is a separate safe projection of confirmed events, introduced by [Issue #22](https://github.com/theroisey/else/issues/22). It is not a substitute for audit history and must not reveal restricted audit data.

## Persistence and historical integrity

The [PostgreSQL foundation](database.md) implements runtime pools and separate embedded Goose migrations. Schema changes use deterministic versioned migrations with documented compatibility, lock behavior, and rollback. Important relationships use constraints and indexes. Client archival preserves linked historical records.

Financial business logic uses integer minor units or decimal values with explicit currency. Tax, rounding, refunds, overpayment, cancellation, and versioning policies are resolved in finance Issues before coding. Current pricing cannot mutate historical billing values.

Persist timestamps in UTC and retain timezone intent where scheduling requires it. Reminder ambiguity around daylight-saving transitions is an explicit requirement, not an implicit conversion.

## Frontend identity

Use shared monochrome tokens, compact navigation, structured tables, restrained radii, thin borders, and tabular numerals. Semantic colors identify states and are accompanied by text. Density serves scanning without compromising focus visibility or keyboard use.

Do not add decorative analytics or pretend integrations exist. Loading, empty, error, success, unauthorized, and disabled states are designed for real features. Only implemented destinations are actionable. The [frontend foundation](frontend-foundation.md) establishes routing, queries, and public health transport without speculative product pages.

## Branches and deployment

The user's current workflow requires **only `main`**. Frontend/backend directories retain domain ownership; coherent incremental commits reference existing issues and run relevant checks before push. Do not create additional issues, development branches or application images for the remaining work. Obsolete branch references were removed after confirming their committed work was in main. Never force-push.

CI gates precede registry publication. Only tested `main` revisions produce production GHCR images. Containers are immutable; the application does not overwrite its own executable. A future deployment target or automatic rollout requires a separately recorded decision and explicit authority.

The repository was initialized through the approved empty commit described in [repository bootstrap](repository-bootstrap.md). Its historical branch policy is superseded by the user's main-only instruction. Managed OCI hosting with PostgreSQL is the reference operating target; an actual account/region/domain and production traffic release require explicit owner authority.
