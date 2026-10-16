# Static delivery and browser cache contract

Baseline: `18be4189cd29f9a0e09be453bff3a50edea9ad91`, including the latest icon changes. The reported credential-stripping network fetch is confirmed in the latest worker: it changes the actual Request to credentials omit, removing same-origin clearance/session cookies. This is corrected by passing the original Request to fetch. The exact credential regression fails against the unchanged baseline worker (omit instead of include) and passes after the fix. Synthetic browser tests verify cookie preservation; live response headers and deployed worker state remain inaccessible, so the exact production 403 response source is not independently observed.

The public worker at `/sw.js` preserves the original network Request, including credentials. Only exact build-generated immutable JS/CSS/font URLs with matching MIME, length and SHA-256 may enter its bounded application-owned cache. API responses, documents, mutable entry points, images, query variants, redirects, challenge pages and errors bypass storage. Cached code is public and account-independent. A separate header-free, credential-free synthetic Request is used only as a Cache Storage key and never for networking. No tokens, private records or user responses enter persistent browser storage. The cache is limited to 128 entries / 4 MiB, each entry at most 1 MiB, with at most four pending verification writes. Quota/storage failures fall back to normal networking.

The cache version derives deterministically from the public build inventory. The existing registration and waiting lifecycle are retained. A waiting update never calls skipWaiting or claims live clients; existing work stays on its current worker until those tabs close. Activation removes only obsolete caches with this implementation's exact ownership prefix. The known earlier v1 cache is removed on activation under the retained application-owned prefix; unrelated caches and registrations are not deleted. A failed startup can check the known root worker once and explain a waiting update, asking users to save work and close all application tabs; it never forces activation. A missing old lazy chunk can still require an explicit refresh after deployment; there is no automatic reload, retry loop or promise of offline operations.

Cloudflare Web Analytics is infrastructure-provided and optional. CSP permits its documented beacon script path and version suffix, while same-origin `/cdn-cgi/rum` already fits connect-src. No analytics token, script injection, extra external connection origin or Cloudflare configuration is introduced. An explicit worker-src self keeps worker permissions restricted after adding the beacon script. All other CSP restrictions remain. Official endpoint reference: https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/.

HTML and mutable bootstrap/worker files revalidate. Content-hashed assets stay immutable. Conditional GET/HEAD uses weak comparison across identity/gzip representations, with consistent Vary and bodyless 304 responses. The build validates HTML/CSS asset references before packaging, and the server refuses missing entry references at startup. Startup failure offers an explicit reload without infinite loading or an automatic navigation that could erase work.

## Findings and compatibility

- Confirmed: the old CSP rejects the reported Cloudflare beacon URL. The server now consumes the checked JSON policy directly, avoiding two copies that can drift. The documented proxied same-origin beacon transport remains allowed without opening an unnecessary external connection origin. No token or analytics installation is invented.
- Confirmed: If-None-Match previously compared literal strong/weak tags; an identity validator missed a gzip representation and vice versa. GET/HEAD now use weak comparison. This was a revalidation inefficiency, not evidence of the production 403 cause.
- Confirmed: the server did not check entry HTML asset references at startup, and asset-like paths under `/app/` could receive SPA HTML. Missing entry references now refuse startup; missing asset URLs return 404/no-store. Build checks cover HTML, CSS font URLs and generated JS dependencies.
- Confirmed: an entry-module failure left the bootstrap loading screen without an action. An independent same-origin startup script supplies localized explicit recovery; optional font failures continue using fallback typography. Route chunk errors retain the existing explicit recovery boundary.
- Unconfirmed: which deployed worker/build produced the reported 403 responses. The latest worker contains the confirmed credential-stripping defect, but the production site is inaccessible through the available read tools. The browser rehearsal simulates challenge responses on an owned loopback gateway; it does not solve or bypass a real edge challenge. Unknown legacy worker URLs/scopes/cache names require inspection before any targeted migration.

No database migrations, account permissions, sessions, APIs, financial rules, visual theme or business data change. The worker is registered after load and fetches no assets during installation. Its inventory/version is deterministic, hashed URLs stay exact, and live clients are never claimed/reloaded. Not-yet-cached old lazy chunks can still require an explicit refresh after an update. Browser HTTP caching remains in use; the worker does not cache HTML or mutable entry points.

## Changed files

| Files | Purpose |
| --- | --- |
| `backend/src/static_files.rs` | Mutable worker/startup MIME, entry reference integrity, weak validators, static fallback boundaries and unit regressions. |
| `backend/src/server.rs`, `backend/internal/http/browser-headers.json` | One browser-header authority and narrow optional beacon permission; conditional response matching. |
| `frontend/public/sw.js`, `frontend/scripts/prepare-service-worker.mjs` | Credential-preserving public worker, deterministic build inventory with the existing optional registration retained. |
| `frontend/public/startup.js`, `frontend/index.html`, `frontend/src/main.tsx` | CSP-safe independent recovery, five localized messages, accessible reload action and readiness signal. |
| `frontend/package.json`, `frontend/scripts/check-bundle-budget.mjs` | Build/test integration, complete entry/font/dependency validation and initial-JS budget including recovery. |
| `frontend/scripts/service-worker.test.mjs` | Network credentials, sanitized cache keys, cache eligibility, failures, bounded eviction and safe lifecycle tests. |
| `frontend/scripts/check-public-cache.mjs` | Real Chromium credentials/challenges/cache/offline isolation/update/draft/recovery rehearsal using actual Pingora artifacts. |
| `frontend/scripts/check-runtime-security.mjs` | Positive optional beacon/CSP synchronization test alongside retained denial probes. |
| `backend/tests/http_smoke.py`, `tools/test-container.py`, `tools/test-browser.py` | Anonymous JS/CSS/font delivery, conditional/HEAD/gzip responses, all-asset image checks and actual-worker browser integration. |
| `README.md`, `frontend/README.md`, `notes/frontend.md`, `notes/frontend-performance.md`, `notes/operations.md`, this file | Operation, security, recovery, historical measurement context and release evidence. |

## Build and deployment

The standard `make build` compiles and prepares all artifacts before the unchanged scratch Dockerfile packages them. The frontend build validates references and generates `/sw.js`; `tools/prepare-artifacts.py frontend` normalizes file/directory permissions and gzip variants. The non-root image checks read every immutable JS/CSS/font asset and compare its bytes, MIME, encoding, validator and cache policy.

After the tested commit is published, an authorized host operator takes a verified backup, runs `docker compose pull` and `docker compose up -d --wait --wait-timeout 60`, preserving `roisey-else-data`. Do not perform this automatically from the application or assume a registry push deploys production. Save work and close old application tabs, reopen, verify `/ready`, `/sw.js` and current HTML JS/CSS/font URLs, then exercise sign-in and an operational page. Confirm the installed root worker and its waiting/active state. Do not unregister unrelated workers or clear unrelated caches. If the old worker has another script URL or a more specific scope, inspect that registration before deciding its targeted migration.

A clean reload revalidates the HTML and mutable scripts. No infinite reloads or challenge retries are used. The only added initial JavaScript is the small recovery/registration code; the worker and inventory load after window load, without precaching optional pages or languages. The build still enforces 250 KB gzip initial JS / 70 KB optional locale / 3 MiB total JS. Prior performance measurements describe their stated baseline; no new production speed or availability claim is made. Physical iOS/Android, real Cloudflare clearance/challenge behavior and the inaccessible production deployment remain separate verification limits.

## Verification evidence

Executed against the integrated source based on `18be418`:

- `npm --prefix frontend test`: 476 frontend tests and five worker security tests passed. The isolated original worker fails the new credential regression with omit instead of include; the corrected worker passes.
- Frontend lint, TypeScript and production build passed. The current initial JavaScript budget is 190,014 bytes gzip; 119 immutable assets fit the inventory bounds. No dependencies were added. The separate recovery bootstrap costs about 2 KiB gzip; the worker/inventory loads after window load.
- `cargo test --locked --offline --workspace`: 97 tests passed; formatting and all-target Clippy with denied warnings passed.
- Real production-binary HTTP smoke passed with SIGTERM and SIGINT, including anonymous asset reads, MIME, gzip/identity equivalence, weak/strong conditional reads, HEAD and no-store private APIs.
- Real Chromium CSP probes passed, including allowed beacon/same-origin POST, exact policy synchronization, and denied eval/inline/unapproved external/other beacon-path scripts, styles, base, forms and framing.
- The real-worker browser rehearsal passed cookie preservation, cache integrity, offline API exclusion, error/challenge exclusion, preserved unsaved input while an update waits, known v1 cache cleanup, new-deployment activation, waiting-update startup guidance, explicit reload recovery, optional analytics failure, and mobile light/dark recovery views. It uses an owned loopback gateway over actual Pingora artifacts, not live Cloudflare.
- Publication policy unit checks and pinned workflow validation passed. The required container and browser CI gates package and exercise the exact application image before promotion. The final delivery report records the actual-image/CI results separately.

Full-image release commands remain `python3 tools/test-container.py --image IMAGE` and `python3 tools/test-browser.py --no-build --image IMAGE`; no external production credentials or customer volumes are needed. These exercise owned disposable fixtures only. Source pushes and registry publication are not production deployment.
