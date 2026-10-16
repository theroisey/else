# Frontend performance audit — 16 October 2026

The audit covered the route graph (45 existing page components), shared controls, all feature families, auth/query boundaries, localization, assets and production delivery. Baseline source: `79f69428a3b87432ac1faaca8d1230a43fed24ff`. The optimized production HTML is bound to its SHA-256 in the [raw measurements](performance/frontend-2026-10-16.json). No production data or service credentials were used.

## Findings and changes

| Area | Finding and implementation |
| --- | --- |
| Entry, routes and locales | Forced single-file output disabled 41 existing lazy boundaries and included four unused language packs. Runtime/core are shared; 46 module loaders now defer pages/workspace and load one optional-language chunk. |
| Navigation and recovery | Public-code intent loading overlaps session discovery and likely navigation. Ready modules render synchronously; a stable wrapper preserves drafts. Workspace and financial recovery controllers remain mounted across routes. Save Data/2G skip speculation. Hover performs no private-data read. |
| Shell and appearance | Multiple subscriptions repeatedly synchronized the same theme. A single shared listener set and a separate synchronization component avoid route-tree updates from theme synchronization. |
| Today, requests, teams, service finance and recurring work | Kept scoped, bounded server queries and polling. Brand search coalesces 200 ms of typing, hides obsolete candidates and shows immediate search feedback. Independent invalidations reconcile concurrently after a confirmed write. |
| Clients, tasks, planning, reminders, administration, audit | Retained existing 25-row pagination, historical references, current permission checks and draft/revision recovery. Lazy routes share genuine skeleton/error boundaries; global admin load failures name the correct destination. |
| Overview, analytics, commerce, marketing | Existing report tables already paginate at 25 rows and charts have bounded date ranges. Virtualization would add complexity without reducing their mounted row counts. Reused exact-number/date formatter configurations instead. |
| Shared interaction system | 140/180 ms tokens coordinate transform-only entry, press, disclosure, drawer, error and mobile-menu feedback. No transition delays a route, guard or dismissal. Loading indicators alone fade. Reduced motion, focus trapping and immediate navigation remain. Mobile menu movement is vertical; drawer clipping contains entry motion. |
| Assets and startup | Preload the two critical Latin fonts; retain Latin/extended-Latin UI glyph coverage and OFL notices. Initial HTML displays an accessible loading indicator before React. No animation library or new runtime dependency. |
| Notifications | A native alert opens the live client-side route instead of reloading the document, preserving the workspace and financial recovery lifetime. |

## Measurement method

Chromium 151.0.7922.173, Node 24.21.0, managed Linux workspace, actual production assets through native Pingora and a disposable synthetic SQLite fixture. Three fresh-browser-context samples per language/profile; English also exercises sign-in and operational navigation with the same owner/scoped-viewer fixtures in both builds. The database is intentionally small: this measures frontend cost, not 500-account capacity or live integrations.

- Desktop: 1440×900, normal CPU, 40 ms latency, 10 Mbps download.
- Mobile lab: 390×844, 4× CPU throttling, 60 ms latency, 3.2 Mbps download.
- Both profiles: 2 Mbps upload. Cold readiness waits for DOM content, the real sign-in input, document fonts and two animation frames. LCP/CLS use buffered browser observers.
- Route times start at the actual DOM click and end two frames after the destination heading, excluding test-driver pointer/stability waits.
- The warm measurement navigates an already authenticated browser to `/login`, then waits for its redirect to Today, including session discovery. It is a full document visit, not internal navigation.

## Results

All values below are medians of three samples.

| Cold sign-in metric | Before | After |
| --- | ---: | ---: |
| Desktop English LCP | 0.972 s | 0.628 s |
| Desktop Turkish LCP | 0.980 s | 0.692 s |
| Mobile English LCP | 2.656 s | 1.304 s |
| Mobile Turkish LCP | 2.724 s | 1.576 s |
| English JavaScript transfer | 576.2 KB | 187.3 KB |
| Turkish JavaScript transfer | 576.2 KB | 235.9 KB |
| Mobile English script execution | 620 ms | 224 ms |
| Mobile sign-in CLS | 0.00049 | 0.00000 |

| Operational timing | Before | After |
| --- | ---: | ---: |
| Desktop first Clients navigation | 51 ms | 61 ms |
| Desktop first Settings navigation | 61 ms | 59 ms |
| Desktop cached Clients navigation | 41 ms | 43 ms |
| Desktop authenticated /login → Today document visit | 374 ms | 951 ms |
| Mobile lab first Clients navigation | 206 ms | 181 ms |
| Mobile lab first Settings navigation | 175 ms | 198 ms |
| Mobile lab cached Clients navigation | 149 ms | 132 ms |
| Mobile lab authenticated /login → Today document visit | 1340 ms | 1186 ms |

The largest observed Event Timing duration across the scripted English interactions was 216 ms before and 96 ms after. This small scripted sample is **not field INP or a p75 claim**. Both builds were already below the CLS goal in these sign-in samples. Cold English transfer fell 67.5%.

Trade-off: desktop full document visits through an authenticated `/login` are slower with deferred workspace code, although still below one second in the final median. The monolithic cached build had an advantage there. Internal desktop navigation remains around 60 ms; mobile cold startup, Clients navigation and warm document visits improved. Do not describe every metric as improved.

An isolated Node formatting microbenchmark (2,000 currency + explicit-UTC date cells, five runs, unchanged exact output) fell from 154.8 ms to 10.3 ms median. It includes the first cache/JIT warm-up sample and is not a whole-page or physical-device measurement.

## Verification and limits

- Passed: 475 frontend tests across 50 files; TypeScript; ESLint; production build and bundle budgets.
- Passed: 34 actual-browser scenarios, including login/rotation/replay, revocation, finance uncertainty, exact currencies, assignments, screenshot delivery/revision, recurring operations, localization, responsive themes and protected evidence.
- Added browser checks for Save Data, no private fetch on hover, reuse of fresh query data, coalesced searches, recoverable chunk failure, native-alert SPA navigation and motion boundaries. Unit coverage protects both cold and prefetched page draft lifetimes.
- Reviewed light/dark mobile screenshots, finance/client navigation and responsive controls. Browser layout assertions cover 360–1920 px. Physical phone rendering and installation were not measured.
- An exploratory benchmark timed out waiting for the window load event. It is excluded from the paired results; the final identical DOM/input/font readiness protocol completed all 24 samples with zero page errors. This is a lab comparison, not a production availability claim.
- Field p75 LCP/INP/CLS, a Lighthouse score, long-session heap profiles and physical-device frame pacing were not measured. No 60 FPS guarantee is claimed.

## Caching and safety decisions

Native gzip, fingerprinted immutable assets and revalidated HTML already provide repeat-visit caching. A service worker was not justified by a measured additional benefit; it would add update/activation complexity to an authenticated application without providing authorized offline business workflows. No API responses, financial values, credentials or screenshots enter persistent browser caches. The application remains network-dependent.

Private query lifetimes, grant/actor partitions, fresh backend authorization and exact financial commands are unchanged. No optimistic financial or workflow success is fabricated. Formatter caches retain at most 64 public configurations per formatter kind, never amounts; implicit-device-timezone dates are not cached. No database/API/schema/authentication policy changes.

## Reproduction and budgets

From the repository root, with pinned Node/Rust tooling and Chromium installed:

```sh
python3 tools/test-browser.py --performance-output /tmp/else-performance.json
# Compare an explicitly retained baseline with the same prebuilt native server:
python3 tools/test-browser.py --no-build --frontend-directory /absolute/baseline/build --performance-output /tmp/else-baseline.json
```

`frontend/scripts/measure-performance.mjs` requires the harness-owned fixture marker and loopback origin. It records only aggregate timings/counts, not customer content, URLs, tokens or credentials. Optional benchmarking stays outside the regular unit-test gate.

`scripts/check-bundle-budget.mjs` runs on every production build: initial JS ≤250 KB gzip, one ≤70 KB gzip chunk per optional language, all JS <3 MiB. Runtime/core grouping avoids a startup waterfall of tiny shared modules. The build gate computes its own compressed sizes; browser measurements record the actual Pingora gzip body sizes.
