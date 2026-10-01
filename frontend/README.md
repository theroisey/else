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

Application routing and query defaults live under `src/app/`, foundation behavior under `src/features/foundation/`, shared primitives under `src/components/ui/`, and HTTP access under `src/services/`. Issue #11 adds the bounded [interface foundation](../docs/interface-foundation.md) and `/interface` review route. Real login and application navigation remain #12. Additional forms, tables and charting dependencies arrive only with concrete consumers.

Implement frontend changes on `frontend`. Backend permissions remain authoritative. No business APIs, customer metrics, credentials, or sessions are simulated here. Docker/production routing and CI are established by #5/#6; frontend changes must continue to pass their existing gates.
