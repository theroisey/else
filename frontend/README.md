# Frontend

The React/TypeScript application uses Vite, Tailwind CSS, Font Awesome, React Router, and TanStack Query. It provides real cookie-session login/logout, a responsive guarded shell, the signed-in account's current access, permission-guarded user/role administration, public service checks and a bounded component review route.

Use Node 24.21.0 and npm 11.19.0:

```sh
nvm use
npm ci
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

Run the Go backend separately on `127.0.0.1:8080`. Vite serves `127.0.0.1:5173` and proxies `/health`, `/ready` and `/api/v1/` during development. Match `AUTH_PUBLIC_ORIGIN` to the browser origin. See the [application shell guide](../docs/application-shell.md) for login, cookies/CSRF, recovery, scope and browser tests; the [foundation guide](../docs/frontend-foundation.md) covers public service checks.

Application routing and query defaults live under `src/app/`, auth transport/session/permission behavior under `src/features/auth/`, navigation/account/current identity under `src/features/shell/`, account/role transport and forms under `src/features/administration/`, foundation behavior under `src/features/foundation/`, and shared primitives under `src/components/ui/`. The [administration guide](../docs/administration.md) covers confirmation, revisions, delegation, password clearing and test evidence. The [interface foundation](../docs/interface-foundation.md) has a `/interface` review route.

Implement frontend changes on `frontend`. Backend permissions remain authoritative. The application has no fixture/demo authentication or simulated business metrics. Component/visual tests use labelled synthetic fixtures; `sh frontend/scripts/test-auth-browser.sh` from the repository root runs Playwright against disposable PostgreSQL and the real Go API. Install Chromium with `npx playwright install chromium` from `frontend/` first. Never run test fixtures against an existing database. Docker/production routing and CI are established by #5/#6; browser authentication is an additional required gate.
