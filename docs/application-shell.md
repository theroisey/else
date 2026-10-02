# Login and application shell

Related Issue: [#12](https://github.com/theroisey/else/issues/12). This frontend slice consumes the existing [identity](identity.md) and [authorization](authorization.md) contracts without changing the API, database or business audit policy.

## Available routes

| Route | Access and behavior |
| --- | --- |
| `/` | Redirects to `/app` |
| `/login` | Checks identity, then signs in or returns to an implemented requested destination |
| `/app` | Requires a verified session; shows the real account and absolute expiry in the device timezone |
| `/app/access` | Requires a verified session; shows and refreshes only the caller's effective grants |
| `/app/users` | Requires global `users.view`; account and scoped role administration |
| `/app/roles` | Requires global `roles.view`; role definitions and controlled permission editing |
| `/app/clients` | Requires some client view grant or global client create; authorized list or create-only context |
| `/app/clients/new` | Requires global `clients.create`; full profile/contact/tag form |
| `/app/clients/:id` | Requires exact-client `clients.view`; compact client workspace |
| `/app/clients/:id/edit` | Requires exact-client view and update; archived records cannot be edited |
| `/status` | Public real liveness/readiness checks |
| `/interface` | Existing public local-state component review surface |

Unknown routes show an explicit fallback. Navigation includes Workspace, My access, permission-guarded Clients/Users/Roles/Audit history and Service status. [Administration](administration.md) and [clients](client-interface.md) consume their owner-merged APIs. [Audit inspection](audit-interface.md) consumes its owner-merged API; billing and releases await their scoped implementations.

## Cookie and transport boundary

Auth transport accepts only three fixed same-origin paths. It uses browser-managed cookies, `credentials: same-origin`, `cache: no-store`, redirect rejection and a ten-second timeout. JSON envelopes are validated before identity is displayed. Raw response bodies, network details and credentials never become UI messages or logs.

Login sends JSON email/password; the browser supplies Origin. Password state is cleared after each attempted request and never enters mutation caches, browser storage, URLs or telemetry. No session/CSRF values are persisted by the application. Logout sends JSON and `X-CSRF-Token` read at request time: HTTPS accepts only `__Host-else_csrf`; loopback HTTP uses `else_csrf`. It never reads the HttpOnly session cookie. A 204 or already-unauthorized response clears protected cache and returns to login. Failed verification/network requests retain the actual session with a safe retry message instead of claiming revocation. Go owns atomic `session.created`/`session.archived` events.

Host Vite now proxies `/api/v1/` to `127.0.0.1:8080`, alongside exact health paths. Match `AUTH_PUBLIC_ORIGIN` to the actual browser origin, for example `http://127.0.0.1:5173`, with the documented explicit loopback cookie mode. `localhost` and `127.0.0.1` are different origins. Production requires HTTPS/Secure cookies and the real external origin. Static `vite preview` does not proxy auth.

## Recovery and permission policy

Initial identity load gates protected content. Lookup errors fail closed even with cached data and present an explicit retry screen. A 401 or absolute expiry removes identity/private queries and returns to login with an ended-session notice. Return paths live only in router memory and are allowlisted implemented destinations; arbitrary URLs, query strings and unknown routes are rejected.

Identity refreshes on focus, reconnection, every sixty seconds while visible and the My access button. Grant changes become visible on the next read. Every future backend operation must still authorize the current actor, permission and exact client. The frontend rejects unknown keys, scope mismatches, absent client context and cross-client grants. A global assignment satisfies a client permission only with an explicit valid client context. There are no role-name checks.

`PermissionGuard` and `visibleDestinations` use the same permission policy. Clients navigation admits either some effective view grant or global create; client pages apply the corresponding collection/create/exact-client guard before loading data. Client route return paths accept only a canonical UUID with the implemented optional edit suffix, or the fixed create route. Filters remain in memory and are excluded from return URLs. Workspace/My access expose only the caller's identity and need a session, so no unrelated administrative permission is invented.

## Accessibility and visual review

Shared primitives supply labels, error descriptions, focus and contrast. The shell adds a skip link, contextual breadcrumb, native account disclosure with Escape/focus return, and mobile navigation with expanded-state toggle, first-link focus and Escape return. Wide tables scroll in a named keyboard-focusable region; narrow layouts and long display names remain contained.

Committed screenshots are explicitly synthetic visual fixtures from intercepted identity responses during local Chromium review, not evidence of real authentication. The application has no fixture mode or demo login. CI separately retains screenshots from its real isolated API flow.

- [Login desktop](screenshots/login-desktop.png), [tablet](screenshots/login-tablet.png), [mobile](screenshots/login-mobile.png)
- [Workspace desktop](screenshots/workspace-desktop.png), [tablet](screenshots/workspace-tablet.png), [mobile](screenshots/workspace-mobile.png)
- [Access desktop](screenshots/access-desktop.png), [tablet](screenshots/access-tablet.png), [mobile](screenshots/access-mobile.png)

## Verification

Run lint, strict typecheck, Vitest, build and dependency audit. Component/service tests cover validation, password clearing, safe login/logout failures, cache removal, malformed/missing identity, retry, 401/timed expiry, exact-client permissions, guarded content, empty grants, return allowlisting and secure CSRF selection.

The required **Browser authentication** CI job installs pinned Playwright/Chromium and runs `sh frontend/scripts/test-auth-browser.sh`. The runner refuses occupied app ports, creates disposable PostgreSQL 18, applies existing migrations/runtime grants, adds clearly synthetic viewer/administrator identities, builds Go and starts Vite. Eleven serial browser flows verify generic denied login, cookie flags, no credential persistence, real CSRF logout/auth audit counts, server-side expiry/reauthentication, revoked-grant refresh, administration writes and audit events, last-administrator protection, disablement/session revocation, the client lifecycle, task/planning workflows, timezone-aware reminder lifecycle, persisted activity, bounded audit inspection with safe differences, exact finance/payment replay and retained cancellation history, and responsive keyboard navigation. Client verification uses a dedicated scoped viewer to respect the real per-identity login attempt budget. Traces, video, request bodies and raw cookie values are not recorded. The runner removes only its own database/processes/temp files on exit. Never provision these known test identities/passwords into a real environment.

Local Docker pulls remain blocked by the anonymous Docker Hub limit. The client slice verifies all five browser flows locally using a newly created disposable PostgreSQL 17.11 database and system Chromium; CI remains authoritative for PostgreSQL 18/container checks. The earlier shell screenshots use intercepted visual fixtures; administration/client screenshots come from real isolated API data. Existing backend race, live PostgreSQL, container/TLS/migration and publication-boundary gates remain required; main publication also waits for browser authentication. No deployment is performed.
