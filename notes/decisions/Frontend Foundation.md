---
type: decision
status: pr-open-for-review
created: 2026-10-01
tags:
  - architecture
  - frontend
  - security
---

# Frontend Foundation

## Decisions

Issue #3 owns typed React tooling and a real public service-status screen. React Router has only the foundation and unknown-route fallback. TanStack Query has actual health/readiness consumers; forms, tables, and charts are not installed speculatively. HTTP calls and runtime decoding stay outside components.

Use exact npm dependencies and a lockfile, Node 24.21.0 LTS/npm 11.19.0, and strict engine checking. The optional fsevents install script is denied; the tested build/dev flow does not require it. No global runtime was changed: the official Node archive was verified against its published SHA-256 and extracted into temporary storage.

Health traffic is same-origin, cancellable, time-bounded, and redacted. The development proxy forwards only exact public health paths to loopback Go. Production routing and containers remain Issue #5. No public build variables, stored credentials, fake client records, business writes, or authorization policy are introduced. Readiness 503 remains an explicit unavailable state until real dependencies exist.

The screen establishes restrained monochrome foundation styling and keyboard controls. It does not replace the deliberate design system (#11) or authenticated shell (#12).

## Verification

A clean npm ci, lint, strict typecheck, service/component tests, production build, and npm audit are the local gates. Browser verification uses temporary Playwright tooling outside the project and actual Go/Vite processes. Desktop/mobile screenshots document real checks; tests exercise keyboard refresh, service failure/recovery, unknown-route navigation, and no horizontal overflow/browser exceptions.

Docker and CI are deferred to #5/#6 rather than reported as passed. Issue #3 remains open until its separate frontend PR is reviewed and merged.

## Related

- [[HTTP Foundation]]
- [Issue #3](https://github.com/theroisey/else/issues/3)
- [PR #35](https://github.com/theroisey/else/pull/35)
- [Frontend foundation guide](../../docs/frontend-foundation.md)
