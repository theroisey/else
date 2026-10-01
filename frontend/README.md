# Frontend

The React/TypeScript application uses Vite, Tailwind CSS, Font Awesome, React Router, and TanStack Query. It provides a development foundation screen with real backend liveness/readiness checks, explicit failure/loading states, keyboard refresh, and an unknown-route fallback.

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

Run the Go backend separately on `127.0.0.1:8080`. Vite serves `127.0.0.1:5173` and proxies only `/health` and `/ready` during development. Readiness reflects actual PostgreSQL connectivity after Issue #4; a database outage remains visible. See the [foundation guide](../docs/frontend-foundation.md) for contracts, query defaults, security, screenshots, and deployment limits.

Application routing and query defaults live under `src/app/`, foundation behavior under `src/features/foundation/`, and HTTP access under `src/services/`. New domains and shared components arrive with their actual consumers. The full design system is Issue #11; real login and application navigation are #12. Forms/tables/charting dependencies are added when needed by their owning slices.

Implement frontend changes on `frontend`. Backend permissions remain authoritative. No business APIs, customer metrics, credentials, or sessions are simulated here. Docker/production routing and CI remain #5/#6.
