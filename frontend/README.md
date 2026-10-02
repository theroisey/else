# Frontend

The React/TypeScript application uses Vite, Tailwind CSS, Font Awesome, React Router, and TanStack Query. It provides real cookie-session login/logout, a responsive guarded shell, the signed-in account's current access, permission-guarded user/role administration, authorized client records and workspaces, public service checks and a bounded component review route. React Hook Form and Zod handle the full client profile/contact/tag form. Task and planning interfaces provide audited operational workflows; the [reminder interface](../docs/reminder-interface.md) adds explicit timezone occurrences, bounded due/terminal views, historical owners/references and revision-safe drafts. It consumes the owner-merged reminder API without backend/schema changes.

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

Client pages, bounded response schemas and domain operations live in `src/features/clients/`; [the client interface guide](../docs/client-interface.md) covers filters, exact-client guards, full replacement forms, archive confirmation and screenshots. Client routes load separately so form/schema dependencies stay out of initial login/public page bundles. Administration and clients share the same authenticated JSON transport under `src/services/authenticated.ts`; each domain validates its own paths, responses and query contract.

The [finance interface guide](../docs/billing-interface.md) documents exact amount entry, permission-gated client finance routes, masked payment history, command reconciliation and the eleventh real-API browser flow. Financial values remain exact strings; backend statuses/totals are authoritative.

The [pricing interface guide](../docs/pricing-interface.md) documents exact line forms and server previews, immutable effective version history, manager-only costs and collection-copy recovery. Pricing lives in `src/features/pricing/`; finance consumes cost-free snapshots and locks copied amounts before payment. The twelfth real-API browser flow verifies retained terms, identical replay after Back and access revocation.

The [overview interface guide](../docs/overview-interface.md) documents the operational client root, one aggregate request, bounded attention, exact currencies, safe activity and permission-aware refresh. Overview lives in `src/features/overview/`; full profile management remains on the linked `/profile` route. The thirteenth browser flow verifies source reconciliation, request counts, responsive keyboard navigation, access loss and retained archived history.
