# React frontend

Typed React/Vite, Tailwind semantic CSS tokens, Font Awesome free-solid, TanStack Query, React Hook Form, and configured JIT-free Zod. Real cookie authentication, exact-client workspaces, finance/pricing, stored provider reports, administration, audit, independent websites, five locales, and Light/Dark/System appearance share one interface system.

From the repository root, `make dev` starts Pingora and `make frontend` starts hot reload at `http://127.0.0.1:5173`. Run `make dev-bootstrap` once for the private local administrator. Vite proxies only the API and health endpoints to loopback `8080`; production serves compiled assets through Pingora at one origin.

Use Node 24.21.0/npm 11.19.0. `make frontend-build` compiles and prepares static assets before Docker. `make check` checks frontend and Rust source; `make test-browser` runs actual cookie/domain/theme/CSP workflows on isolated synthetic SQLite storage. Install Playwright Chromium first. The image browser gate uses the exact tested image without replacing its assets.

Read the [frontend maintenance notes](../notes/frontend.md) and [domain contracts](../notes/domains.md). Keep credentials out of query/React state and browser storage, exact values out of floating-point arithmetic, and late private responses out of obsolete actor/grant/route contexts. Preserve memory-only drafts and financial reconciliation on uncertain writes.
