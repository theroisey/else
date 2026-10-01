# Architecture baseline

Status: proposed engineering direction for [Issue #1](https://github.com/theroisey/else/issues/1). The baseline documents boundaries; it does not claim these services exist.

## Application shape

Roisey Else starts as a modular monolith: one Go backend, one React frontend, and PostgreSQL. Add infrastructure only when a concrete Issue establishes a product need. Docker development uses frontend, backend, and postgres services after [Issue #5](https://github.com/theroisey/else/issues/5).

The frontend owns presentation, interaction, accessible forms, query state, and client-side validation for usability. It does not own authorization or financial calculations. The backend owns authenticated identity, permissions, client isolation, validation, domain invariants, exact calculations, persistence, and audit writing.

## Backend boundaries

HTTP handlers decode requests, invoke an application service, and encode a stable response. Application services orchestrate permission checks and transactions. Domain rules define state transitions and financial invariants. Database code owns queries, constraints, and transaction primitives. Provider adapters translate external contracts into internal data.

Avoid generic repositories, provider interfaces, or service layers without consumers. Shared boundaries should emerge from a concrete slice rather than a speculative framework.

## API contracts

Business APIs use `/api/v1`. Every implemented endpoint has a documented request/response/error contract shared with its frontend Issue. Collections have bounded pagination; filtering and sorting are explicit. Input validation rejects unsupported values, malformed identifiers, and inappropriate sizes without exposing internal errors.

The [HTTP foundation](backend-http.md) defines the error envelope, request ID, and health/readiness semantics. Pagination belongs to the first collection API. This baseline does not invent frontend fields or unimplemented responses.

## Security and client scope

The backend denies access without a valid identity, required permission, and relevant client scope. Roles collect permissions; application code checks permissions rather than role names. Knowing a client or record ID never establishes access.

Session, CSRF, password, rate-limit, and administrator bootstrap decisions are recorded in [Issue #8](https://github.com/theroisey/else/issues/8) before implementation. Global/client scope and grant rules are recorded in [Issue #9](https://github.com/theroisey/else/issues/9). No implicit administrator bypass or account-creation privilege is introduced here.

Integration credentials remain backend-only. Logs, URLs, frontend bundles, and audit payloads exclude secrets and sensitive payment references. Runtime database access and migration access have explicitly designed privileges.

## Audit and activity

[Issue #7](https://github.com/theroisey/else/issues/7) establishes append-oriented audit infrastructure before business mutations. A successful significant mutation and its audit event share a database transaction. Safe field allowlists govern snapshots and metadata; passwords, tokens, and provider credentials never enter audit records.

User-facing activity is a separate safe projection of confirmed events, introduced by [Issue #22](https://github.com/theroisey/else/issues/22). It is not a substitute for audit history and must not reveal restricted audit data.

## Persistence and historical integrity

The [PostgreSQL foundation](database.md) implements runtime pools and separate embedded Goose migrations. Schema changes use deterministic versioned migrations with documented compatibility, lock behavior, and rollback. Important relationships use constraints and indexes. Client archival preserves linked historical records.

Financial business logic uses integer minor units or decimal values with explicit currency. Tax, rounding, refunds, overpayment, cancellation, and versioning policies are resolved in finance Issues before coding. Current pricing cannot mutate historical billing values.

Persist timestamps in UTC and retain timezone intent where scheduling requires it. Reminder ambiguity around daylight-saving transitions is an explicit requirement, not an implicit conversion.

## Frontend identity

Use shared monochrome tokens, compact navigation, structured tables, restrained radii, thin borders, and tabular numerals. Semantic colors identify states and are accompanied by text. Density serves scanning without compromising focus visibility or keyboard use.

Do not add decorative analytics or pretend integrations exist. Loading, empty, error, success, unauthorized, and disabled states are designed for real features. Only implemented destinations are actionable. The [frontend foundation](frontend-foundation.md) establishes routing, queries, and public health transport without speculative product pages.

## Branches and deployment

`main` remains the production branch. Frontend implementation belongs on `frontend`; backend implementation belongs on `backend`. Cross-cutting slices define contract order and use coordinated PRs. After a merge, synchronize both development branches from `main` without force pushes before substantial work continues.

CI gates precede registry publication. Only tested `main` revisions produce production GHCR images. Containers are immutable; the application does not overwrite its own executable. A future deployment target or automatic rollout requires a separately recorded decision and explicit authority.

The repository was initialized through the approved empty commit described in [repository bootstrap](repository-bootstrap.md). The one-time exception is consumed; subsequent changes to main use PRs.
