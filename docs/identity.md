# Identity and cookie sessions

Related Issue: [#8](https://github.com/theroisey/else/issues/8). This backend slice provides identity storage, one-time bootstrap, login/logout/current-session endpoints and revocable cookie sessions. It does not add self-registration, password recovery, MFA, roles/permissions, client scope or a login screen. The frontend contract is consumed by the application-shell Issue.

## Security contract

Users have a canonical lowercase ASCII email, a trimmed display name, active/disabled status and an Argon2id password hash. Passwords must be 12–128 UTF-8 bytes. Hashes use a random 16-byte salt, 19 MiB memory, two iterations, one lane and a 32-byte output. Verification accepts only this bounded PHC format before allocating, performs the same hash work for unknown, disabled and wrong-password attempts, and returns the same public error. Passwords and hashes never enter responses, cookies, logs or audit snapshots.

Sessions use independent 32-byte random URL-safe tokens. PostgreSQL stores only SHA-256 token and CSRF digests, a UUID, user reference, creation/expiry and optional revocation. The fixed absolute lifetime is 12 hours without sliding renewal. Login creates a new session; logout sets `revoked_at`; expired, revoked and disabled-user sessions all return the same unauthorized response. Session rows are retained for security history; retention/deletion needs a later reviewed policy.

The session cookie is HttpOnly, SameSite=Strict, Path=/, host-only and Secure by default. The CSRF cookie has the same scope but is readable so the same-origin frontend can copy it to `X-CSRF-Token`. Both raw values exist only in the browser. Never put them in localStorage, logs, URLs or telemetry. Production uses `__Host-else_session` and `__Host-else_csrf`. Explicit loopback HTTP development uses `else_session` and `else_csrf` because browsers prohibit the `__Host-` prefix without Secure.

Every unsafe auth request requires an exact `Origin` equal to `AUTH_PUBLIC_ORIGIN` and `Content-Type: application/json`. Logout additionally requires a constant-time match between its CSRF header, CSRF cookie and session-bound database digest. Login has no existing session and relies on exact Origin, JSON-only input, SameSite response cookies and throttling. Responses do not enable credentialed CORS.

The in-process login limiter allows five attempts per 15 minutes per digest of direct peer IP plus canonical email. It stores at most 10,000 buckets, refuses overflow and exposes a generic 429 with `Retry-After`. It supplements trusted-edge or distributed limiting; it is not cluster-wide. The backend ignores `Forwarded` and `X-Forwarded-For`. Deployments configure the external public origin and must rate-limit at the edge when a reverse proxy makes many clients share one direct peer.

[#111](https://github.com/theroisey/else/issues/111) independently caps actual password hashing/verification at two synchronous operations per API process, shared by identity and user administration. See [password work admission](password-work.md). Full admission returns a fixed 503 `service_busy`, `Retry-After: 1`, no cookies and no successful mutation/audit. There is no request queue; cancellation does not release a running operation's slot before its CPU work ends. The Argon policy and known/unknown/disabled/wrong-password verification remain unchanged. This local resource bound supplements deployed edge/distributed protection.

Logs contain fixed authentication event/error codes and the server request ID, without email, password, cookie/token, CSRF value, Origin, user agent or forwarded IP. Successful login and logout write `session.created` and `session.archived` atomically with the session mutation using the verified user actor. The bootstrap writes `user.created` atomically. Denied logins have no business mutation and produce safe logs rather than attacker-amplifiable database rows.

## API contract

`POST /api/v1/auth/login` accepts:

```json
{"email":"person@example.com","password":"the supplied password"}
```

A successful response sets both cookies and returns only safe current identity data:

```json
{"data":{"user":{"id":"uuid","email":"person@example.com","display_name":"Person","permissions":[{"permission":"roles.manage","scope":"global"}]},"session":{"expires_at":"2026-10-01T23:00:00Z"}}}
```

`GET /api/v1/auth/session` returns the same shape for a valid session. `POST /api/v1/auth/logout` requires `Origin`, JSON content type, both cookies and `X-CSRF-Token`, revokes the session, clears both cookies and returns 204. The frontend reads the CSRF cookie for the header; no endpoint returns the value in JSON.

Wrong email/password and disabled users receive `401 invalid_credentials` with “Email or password is incorrect.” Missing, malformed, expired and revoked sessions receive `401 authentication_required`. Origin and CSRF failures are 403, invalid JSON is 400, unsupported content type is 415 and throttling is 429. All JSON errors use the existing safe envelope and server request ID. Account status, bootstrap state and password details are never disclosed.

## Configuration and database grants

`AUTH_PUBLIC_ORIGIN` is required and must be an exact HTTP(S) origin without credentials, path, query or fragment. `AUTH_COOKIE_SECURE` defaults to true and requires HTTPS. Setting it to false is accepted only for an HTTP loopback origin. The local Compose environment sets `http://localhost:${FRONTEND_PORT}` and explicitly disables Secure; a real deployment must provide its external HTTPS origin and keep the default.

Migration `000003_create_identity.sql` adds users, sessions, uniqueness/expiry constraints and indexes. Runtime has no bulk identity-table access. Security-definer functions with fixed `pg_catalog` search paths expose one login lookup, one transaction-lock lookup and one current-session lookup; PUBLIC cannot execute them. Runtime can update only last-login timestamps and session revocation, insert the explicit session columns, and invoke these functions. It cannot select emails/hashes/tokens directly, alter bootstrap state, insert users, delete/truncate identity history or own schema objects.

For local Compose, run the reviewed grants after migrations:

```sh
docker compose exec -T postgres psql -U postgres -d else < backend/scripts/grant-runtime.sql
```

Production operators should apply the equivalent statements from that file with their actual runtime role after migration review. Avoid blanket/default grants. Migration down takes an exclusive lock and refuses any user or session row; an empty migration is reversible. Reapply grants after an empty down/up.

## Initial administrator bootstrap

Bootstrap uses the migration owner through a separate `BOOTSTRAP_DATABASE_URL`; the API process never receives it. It acquires a transaction advisory lock, requires zero existing users, reads the password from an interactive terminal without echo, creates exactly one active identity with `bootstrap_admin=true`, assigns the ordinary Initial Administrator role, and writes both audit events in the same transaction. A repeat attempt fails. The marker grants no application permission and is never returned or checked as authorization; [Issue #9](authorization.md) consumes it into the initial RBAC assignment.

For local Compose after migration and runtime grants:

```sh
BOOTSTRAP_ADMIN_EMAIL=owner@example.com \
BOOTSTRAP_ADMIN_NAME='Initial Administrator' \
docker compose run --rm bootstrap-admin
```

Enter the password only at the prompt. Do not pass it in an argument, environment variable, shell history or `.env`. For a non-Compose environment, set the two non-secret identity fields and `BOOTSTRAP_DATABASE_URL` privately, then run `go run ./cmd/bootstrap-admin` from `backend/` in a terminal. Protect and remove bootstrap/migration credentials after initialization. The resulting identity receives the Initial Administrator permission set through a normal global role assignment.

## Verification

Unit tests cover Argon2id parsing/parameter bounds, input normalization, secret generation, limiter windows/capacity and auth-origin configuration. PostgreSQL integration covers one-time bootstrap, hashed storage, generic negative authentication, disabled/expired/revoked sessions, CSRF and secure cookies, runtime permission denials, atomic rollback when audit INSERT fails, audit events and nonempty rollback refusal. The full migration suite checks empty up/down across all versions. Compose verifies configuration, denied identity privileges, route wiring and production/development images.

[CI run 36865279033](https://github.com/theroisey/else/actions/runs/36865279033) passed frontend compatibility, backend race/vet/static builds, real PostgreSQL 18 integration and full development/static Compose verification for revision `0fa3130ca1edd6f5796f20d1fbfceba4ef68c4f2`; publication correctly skipped on the PR. Local Docker execution remains blocked by Docker Hub's unauthenticated pull limit, so GitHub supplied runtime evidence. [PR #42](https://github.com/theroisey/else/pull/42) is the review path. No production deployment occurred.
