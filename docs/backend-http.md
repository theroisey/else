# Backend HTTP foundation

Related Issue: [#2](https://github.com/theroisey/else/issues/2).

## Implemented scope

The Go backend has configuration validation, structured JSON logging, server-owned request IDs, safe HTTP errors, liveness/readiness endpoints, timeouts, bounded headers, and graceful shutdown. HTTP transport uses the standard library; the database layer uses pgx and separate Goose migration tooling.

PostgreSQL lifecycle is implemented in the [database guide](database.md), audit persistence in [the transaction contract](audit-log.md), and authentication in [the identity contract](identity.md). Docker, CI and [RBAC](authorization.md) are implemented. [Administration](administration.md) adds user/role routes; client records and financial routes remain later work.

The module requires Go 1.27.1, selected from the [official stable release metadata](https://go.dev/dl/?mode=json) during implementation. The verification toolchain was downloaded into temporary storage and checked against the official archive SHA-256; no global installation was changed.

## Run and verify

From `backend/`, with the documented Go toolchain available:

```sh
# Export DATABASE_URL securely as described in docs/database.md first.
go run ./cmd/api
```

The default listener is `127.0.0.1:8080`. Environment values are read directly; the application does not automatically load `.env` files.

```sh
HTTP_ADDRESS=127.0.0.1:8081 LOG_LEVEL=debug go run ./cmd/api
go vet ./...
go test ./...
go test -race ./...
go build -o bin/api ./cmd/api
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o bin/api-linux ./cmd/api
gofmt -l cmd/api internal
```

`gofmt -l` must produce no output. Race tests require a supported native C toolchain. Tests open temporary loopback listeners; the execution environment must permit that access. No database or external account is required.

## Configuration

| Variable | Default | Validation |
| --- | --- | --- |
| `HTTP_ADDRESS` | `127.0.0.1:8080` | IP address, `localhost`, or explicit wildcard host; decimal port 1–65535; bracket IPv6 |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `HTTP_READ_HEADER_TIMEOUT` | `5s` | Positive Go duration, at most `5m`; no greater than read timeout |
| `HTTP_READ_TIMEOUT` | `15s` | Positive Go duration, at most `5m` |
| `HTTP_WRITE_TIMEOUT` | `15s` | Positive Go duration, at most `5m` |
| `HTTP_REQUEST_TIMEOUT` | `5s` | Positive Go duration, greater than readiness timeout and less than write timeout, at most `5m` |
| `HTTP_IDLE_TIMEOUT` | `60s` | Positive Go duration, at most `5m` |
| `HTTP_SHUTDOWN_TIMEOUT` | `10s` | Positive Go duration, at most `5m` |
| `HTTP_READINESS_TIMEOUT` | `2s` | Positive Go duration, less than request/write timeout, at most `5m` |
| `HTTP_MAX_HEADER_BYTES` | `16384` | Integer 1024–65536 |
| `AUTH_PUBLIC_ORIGIN` | required | Exact HTTP(S) origin; HTTPS required for secure cookies |
| `AUTH_COOKIE_SECURE` | `true` | `false` only with an HTTP loopback origin |
| `INTEGRATION_KEYRING_FILE` | absent: key-dependent runtime disabled | Protected absolute regular file; explicit invalid configuration fails privately before listening |
| `INTEGRATION_KEYRING_MODE` | `normal` | Exactly `normal` or `restored`; requires a configured file |

Present but empty configuration values fail validation. Validation errors name the setting and constraint, never its raw supplied value. Defaults bind locally; container binding and production TLS termination are documented by their future deployment Issues.

[#109](https://github.com/theroisey/else/issues/109) adds a synchronous request-context deadline; see [runtime resource budgets](runtime-budgets.md). Earlier caller deadlines remain earlier. Context-aware SQL/acquisition must honor cancellation; no timeout goroutine competes to write a response. An error rendered after the request deadline uses 503 `request_timeout`, fixed text `The request timed out. Refresh before retrying.`, and the normal JSON/no-store/correlation guards. Actual successful responses retain their status; client cancellation stays distinct. CPU work or body readers that ignore context are not forcibly preempted. Socket read/write limits and independent SQL budgets remain necessary.

Integration key settings use a single fixed startup failure event, without setting paths, key identities or raw diagnostics. See [protected loading and declared restore operations](integration-key-startup.md) for Linux permissions, read-only preflight, disabled defaults and limits. These checks add no provider/credential producer and do not change ongoing readiness.

## Endpoint contract

`GET` and `HEAD` are accepted on exactly `/health` and `/ready`. Unsupported methods return `405` with `Allow: GET, HEAD`. Unknown paths, including unimplemented `/api/v1` business routes, return `404`.

The exact auth routes `/api/v1/auth/login`, `/api/v1/auth/logout`, and `/api/v1/auth/session` are described in [identity](identity.md). User/role/permission routes are described in [administration](administration.md). Other unimplemented `/api/v1` paths return 404.

- `/health`: `200` with `{"status":"ok"}` when the process serves HTTP. It does not assert database or integration health.
- `/ready`: `200` with `{"status":"ready"}` only after a configured dependency checker succeeds before its deadline. Returns `503` while the checker is missing, fails, times out, or the server is draining.
- `HEAD` returns the corresponding status and headers without a body.

The executable wires a real PostgreSQL pool check through `ReadinessCheck(context.Context) error`. Startup fails without a valid DATABASE_URL and successful connection; readiness is 200 while connectivity succeeds and 503 on a subsequent outage. A checker must respect context cancellation and test every required dependency. A nil or timed-out checker must never be treated as healthy.

Accepted requests receive `X-Request-ID`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Caller-supplied request IDs are ignored; the backend creates a fresh ID and places it in shared internal/correlation context for application services and audit INSERT. The reusable RequestMiddleware owns ID generation; trusted jobs/CLI operations use correlation.New.

## Error contract

Handler errors use this envelope; the same structure applies to future versioned APIs:

```json
{
  "error": {
    "code": "not_ready",
    "message": "Service is not ready.",
    "request_id": "server-generated-id"
  }
}
```

Foundation codes include `not_found`, `method_not_allowed`, `not_ready`, and `internal_error`; auth adds stable codes documented in the identity guide. Messages exclude raw internal errors, configuration values, dependency credentials, and stack traces. Errors arising before handlers run may use standard-library responses without a generated request ID.

No pagination convention is implemented until an actual collection API requires one. Business validation, permissions, and domain error codes are defined by their owning Issues.

## Logging and recovery

Requests emit structured completion events with `request_id`, a recognized method or `OTHER`, fixed route label, status code, duration in milliseconds, and aborted state. Unrecognized paths use `unmatched`. Logs exclude request/query strings, raw unknown paths, bodies, authorization headers, cookies, user agents, and panic values.

A panic before headers produces a generic `500` and a safe correlated failure event. A failure after headers aborts the connection instead of appending a misleading success/error body. Standard HTTP transport diagnostics are converted into a fixed structured event; their raw text is intentionally excluded because it can contain request or panic details.

## Shutdown

SIGINT/SIGTERM marks readiness unavailable, stops accepting new connections, and allows active requests to finish within the configured shutdown deadline. On deadline expiry, force-close connections and return an error. Request contexts are not prematurely tied to the signal context, so ordinary shutdown can complete active work. The lifecycle waits for the serving goroutine to finish before returning.

The ordering follows the [Go HTTP shutdown contract](https://pkg.go.dev/net/http#Server.Shutdown). Tests use real listeners to prove graceful completion, deadline closure, cancellation, and listener failure propagation.
