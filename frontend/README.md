# Frontend

This directory owns the React application. Production code and tooling start in [Issue #3](https://github.com/theroisey/else/issues/3); design tokens and primitives start in [Issue #11](https://github.com/theroisey/else/issues/11).

Use React, TypeScript, Vite, Tailwind CSS, and Font Awesome. React Router, TanStack Query, React Hook Form, Zod, and TanStack Table serve actual routes, queries, forms, and tables as those consumers arrive. Do not install overlapping libraries or unused charting dependencies.

Organize source by domain under `src/features/`; shared UI belongs under `src/components/`. Keep API access behind services and business rules outside components. Backend enforcement remains authoritative even when the UI hides a restricted action.

Implement frontend changes on `frontend`. The initial `frontend` branch originates from the approved empty `main` baseline; [the bootstrap record](../docs/repository-bootstrap.md) documents initialization.

No frontend runtime or package manifest exists yet. Required lint, typecheck, test, and build commands arrive with Issue #3.
