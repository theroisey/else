# Frontend foundation

Related Issue: [#3](https://github.com/theroisey/else/issues/3).

## Scope

A React/TypeScript frontend runs through Vite with Tailwind CSS and Font Awesome. React Router owns the foundation route and an accessible unknown-page fallback. TanStack Query owns cancellable, bounded public service checks and manual refresh. This is a development foundation, not a client dashboard or authenticated application shell.

The screen checks the implemented Go `/health` and `/ready` contracts. It has loading, unavailable, error, success, and disabled-refresh states. Backend failures and malformed responses never become fabricated availability. There are no customer fixtures, business routes, charts, writes, login forms, or inactive navigation items.

## Toolchain and commands

Use Node.js 24.21.0 and npm 11.19.0. `.nvmrc`, `engines`, `engine-strict`, exact direct versions, and `package-lock.json` make the expected environment explicit. Node 23 on the initial host is not the supported development runtime. Verification used a temporary official Node 24 archive checked against its published SHA-256; no global installation was changed.

From `frontend/`:

```sh
nvm use
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

If nvm is unavailable, install the documented Node version with your chosen version manager. Do not disable engine checking to run an unsupported toolchain. Use `npm ci` for reproducible installs. The optional `fsevents` install script is explicitly denied; the foundation builds and runs with the portable watcher. Review new dependency lifecycle scripts individually rather than granting blanket permission.

Run the [Go backend](backend-http.md) separately on its default loopback address `127.0.0.1:8080`. The Vite development server binds `127.0.0.1:5173` and refuses to silently select another occupied port. Only exact `/health` and `/ready` paths proxy to the local backend. No wildcard business API forwarding or frontend CORS workaround is introduced.

## Transport and query contract

HTTP access lives in `src/services/http.ts`; the feature service decodes the documented endpoint shapes. Components use queries rather than sending requests directly. Requests are same-origin, use `credentials: same-origin`, disable cache, reject redirects, and combine query cancellation with a five-second timeout. Modern browsers must support `AbortSignal.any` and `AbortSignal.timeout`.

Only `200` with the expected `status` is available. Readiness `503` with a valid `not_ready` envelope is displayed as **Not ready**. Missing/malformed JSON, incorrect content type, other status codes, and network failures are **Check failed**. Raw response bodies and network errors never appear in the UI. Issue #4 now implements the real PostgreSQL checker: readiness is available when connectivity succeeds and unavailable during an outage.

Queries are stale after 15 seconds and unused data is collected after 60 seconds. There are no automatic retries or focus-triggered requests. **Check again** refreshes both checks; it is disabled during requests. A failed refresh replaces a previously successful status rather than retaining a misleading badge.

No public build variables or integration credentials exist. This screen introduces no browser credential storage or authentication policy. Future session/CSRF requirements belong to Issue #8, and permission-aware navigation belongs to #12.

## Structure and visual scope

`src/app/` contains routing, query defaults, and minimal foundation styles. `src/features/foundation/` contains the service-status screen and its contract decoder. `src/services/` owns HTTP access; `src/test/` owns shared test cleanup. Domain folders are added when their own Issues deliver actual consumers.

The initial screen uses thin borders, monochrome surfaces, small radii, restrained typography, responsive status rows, text status labels, visible keyboard focus, and a polite live region. The Font Awesome refresh icon accompanies a text button. No remote font or icon kit is loaded. Issue #11 now provides the shared [interface tokens and primitives](interface-foundation.md); the authenticated application shell remains Issue #12.

[Desktop screenshot](screenshots/frontend-foundation-desktop.png) and [mobile screenshot](screenshots/frontend-foundation-mobile.png) were captured from the real backend/Vite flow. They contain no customer data.

## Verification and deployment boundary

Tests cover health/readiness contracts, cancellation, response validation, safe errors, loading/disabled states, keyboard refresh, outage recovery, failed refresh replacing success, and unknown-route navigation. The built application was also checked in headless Chromium against the real Go process and Vite proxy at desktop and mobile widths, including backend outage/restart, absence of horizontal overflow, and absence of browser exceptions.

`npm ci`, lint, strict typecheck, tests, production build, and dependency audit are required local gates. Dependency audit is evidence at check time, not a guarantee against future advisories. CI gates arrive in Issue #6; Docker packaging arrives in #5 and is not claimed here.

`dist/` is the static production artifact. `vite preview` is a local preview, not a production server. Deployment must serve static assets with SPA fallback and route the public health endpoints to the backend on the same origin. The production web-server/container configuration is explicitly deferred to #5. No image publishing or production deployment occurs in this Issue.

## References

- [Vite installation and runtime requirements](https://vite.dev/guide/)
- [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite)
- [React Router declarative installation](https://reactrouter.com/start/declarative/installation)
- [Vitest setup](https://vitest.dev/guide/)
- [Node release support](https://nodejs.org/en/about/previous-releases)
