# Roisey Else interface redesign

The workspace uses architectural divisions, a warm neutral material palette and an editorial type hierarchy. Operational content stays compact: tables, forms and navigation use Manrope; page headings and selected financial values use Instrument Serif. Figures retain the existing exact decimal/currency formatting and tabular alignment. No business calculations, schema, API or authentication contract changes accompany this work.

## Source audit

The audit covered the registered routes in `frontend/src/app/App.tsx`, every domain's pages and shared controls, the application and client navigation, responsive grids, loading/error/permission states, native dialogs, and the GA4, WooCommerce and Meta SVG charts. Tailwind 4 consumes CSS theme definitions; there is no separate Tailwind configuration file. The previous implementation had one light palette, system-font fallbacks, repeated bordered panels, inconsistent client navigation subsets, and no persisted appearance selection.

| Surface | Treatment |
| --- | --- |
| Application shell | 232px sidebar, thin active indicator, quiet context bar, integrated account menu and keyboard search |
| Login | Editorial introduction, precise unboxed form, restrained branding and appearance control |
| Workspace | Real authorized destinations and session context; no invented portfolio totals or performance statistics |
| Clients | Portfolio header, filter bar, direct ledger table and bounded existing pagination |
| Client overview/profile | Shared permission-aware dossier tabs, editorial identity, financial position, operational attention and contextual rail |
| Tasks, planning, milestones, reminders | Unified client tabs, ruled record sections, compact table controls, structured editing and honest loading states |
| Finance | Separate currency ledger, aligned exact amounts, emphasized outstanding balances, retained payment/recovery/confirmation behavior |
| Pricing | Agreement ledger replaces floating agreement cards; retained versions, cost permissions and exact calculations are preserved |
| GA4, WooCommerce, Meta | Ruled metric strips, theme-aware chart/reference-line tokens, aligned measured tables and explicit report-status context |
| Activity and audit | Ruled timeline/ledger, exact safe identifiers, filter controls and audit inspection drawer |
| Users and roles | Shared page headers, compact administration tables, editing drawers and separate destructive confirmations |
| Releases | Quiet read-only system evidence; no fake deployment state or update actions |
| Account / appearance | Light, Dark and System previews alongside the existing effective-permissions page |
| Public status / interface review / route errors | The same typography, semantic palette, controls and appearance architecture |

## Tokens and themes

`frontend/src/app/styles.css` owns material, primary/secondary/muted text, border, focus/accent, semantic-state, chart, radius and overlay tokens. Existing semantic Tailwind names remain aliases to these CSS variables. Components do not own arbitrary light/dark color values. Theme preview swatches deliberately depict the two palettes; their split System thumbnail is a preference illustration rather than an application gradient.

Light canvas is warm ivory (`#F2F0EA`) with `#F8F7F3` surfaces. Dark uses an independently layered `#11110F` canvas, `#171715` surfaces, `#1D1D1A` quiet regions and `#23231F` overlays. Muted text and semantic colors have separate dark values. Primary buttons use the theme's contrast color; status dots always accompany text. Charts use primary/secondary/accent/positive/negative/grid tokens rather than private color literals. Reduced motion suppresses skeleton pulses, overlay entry and color transitions.

`frontend/public/assets/theme-init.js` is a blocking same-origin classic script in the document head, before CSS/application rendering. It accepts only Light/Dark/System values from `roisey-else.appearance`, applies the resolved root class, and defaults to System for unavailable or malformed storage. `appearance/theme.ts` keeps the same contract, persists only this non-sensitive preference, updates mounted controls, follows device changes in System, and synchronizes other browser tabs. Restricted storage retains a usable preference for the current session. Account credentials remain in the existing HTTP-only cookie system.

The public status screen uses `/service-status` because `/status` is the existing JSON API endpoint. The frontend static route allowlist explicitly serves the new screen without changing the API endpoint.

The CSP remains unchanged: no remote fonts, inline/eval scripts or style allowances are introduced. `assetsInlineLimit: 0` ensures small WOFF2 subsets remain same-origin resources rather than blocked data URLs. Docker's build context includes the public bootstrap. The frontend packaging stage normalizes public directories/files to 0755/0644: Vite preserves copied public-file permissions, and a restrictive bootstrap file otherwise prevents the unprivileged API from loading the artifact. Font licenses are retained in `docs/licenses` and `/usr/share/licenses/else` in the existing single application image.

Chart bars are bounded and centered within observation slots, including single-observation reports. Dates align with the plotted observations. Narrow screens retain a minimum readable plot width inside a focusable, independently scrolling figure; arrow keys pan the plot without creating document overflow. Missing dates and missing series retain their original measured/unmeasured semantics. Exact source numbers remain available in the accompanying tables and SVG titles.

## Interaction and access

The command palette opens with Ctrl/⌘ K, accepts keyboard arrows/Enter/Escape, restores focus, and searches registered authorized destinations, current-client modules and existing active-client name search. Client reads start after two characters and a 200ms debounce; results are bounded by the existing API page. It invents no global task/finance search endpoint. Destructive actions retain their confirmation and revision checks. Complex administration forms and audit inspection use the shared native modal drawer, including focus containment and restoration.

Client tabs are derived from effective grants. Client audit additionally requires client read access. Permission gates, uncertain payment/copy recovery, provider credential clearing, expiry/revocation handling, pagination and all existing transport behavior remain in place.

## Authentic brand asset

The owner supplied the official Roisey SVG directly on 2026-10-05. `components/brand/Brand.tsx` embeds that exact path, replaces the temporary ROISEY text, and retains the original 46:64 aspect ratio with `viewBox="0 0 46 64"`. Its original white fill becomes `currentColor`, so the mark follows the theme's primary text color without filters, distortion or decorative effects. The mark measures 32px high in the desktop shell, 28px in the mobile shell and 40px on login. The accessible name is “Roisey Else”; the decorative SVG is excluded from keyboard focus and repeated screen-reader announcements.

Provenance is the owner's SVG code in this task, rather than an independently retrieved asset URL. The managed network still returns HTTP 403 for `https://roisey.com`, so website/source inspection remains unavailable. No website-derived typography, color palette, quote or other brand claim is made. The muted taupe accent is an interface design choice accompanying the supplied monochrome mark.

## Verification

Local verification uses Node 24.21.0, npm 11.19.0, Go 1.27.1, PostgreSQL 18 and Chromium. The built frontend is served by the actual Go API with the declared CSP and an isolated fixture database; it is not a mocked browser-only demo.

| Check | Result |
| --- | --- |
| Frontend lint, TypeScript and production build | Passed |
| Complete frontend unit suite | 522 tests in 44 files passed |
| Report regression tests after final chart refinement | 44 tests passed |
| Fresh-database browser suite against the actual Go API | All 22 passed, including cold-load Dark/System, persistence, responsive login and the existing operational workflows |
| Owner-supplied SVG integration | 28 shell/login checks passed for geometry, theme color and seven viewport widths; 15 authentication/appearance/search unit regressions and all 22 browser tests passed after integration |
| Complete frontend dependency audit, including development dependencies | Zero vulnerabilities reported |
| Targeted Go HTTP tests and formatting | Passed, including GET/HEAD of `/service-status` |
| Built-artifact browser security | Same-origin fonts/icons/API passed; eval, inline/external scripts, styles, base, form and framing attacks blocked |
| All registered page families and detail/edit/create routes | 49 routes, 698 light/dark and responsive checks passed |
| Priority-page review after spacing/contrast/drawer fixes | 17 routes, 250 checks passed |
| Additional role/assignment drawers, account menu and charts | Both themes passed; mobile chart labels remain readable and arrow-key scrolling works |
| One-container runtime | Initialization, automatic migrations/grants, process/role isolation, routing, shutdown, restart/replacement persistence, backup/restore, child failure and key safeguards passed |

The route matrix checks 1280, 1440, 1600 and 1920px desktop widths plus 820, 390 and 320px. No document/control overflow or browser runtime errors were observed. Tables and charts may scroll within their own regions. Manual image inspection covered both themes across all page families, then the final priority screens, drawers, account menu and chart figures. It led to stronger input borders, consistent integration headers, compact inline row actions, full-width mobile drawers, readable mobile chart labels and restrained sparse-data bars.

[Reviewed screenshots and machine-readable manifests](screenshots/redesign/README.md) contain only isolated synthetic records. Operational screenshots visibly identify that provenance; public login screenshots contain no account data. No provider requests were made during visual review. Evidence describes the tested worktree, not a production rollout. The owner-supplied mark is used in the shared shell and login branding.

Work uses `main` and the existing frontend issues #11/#12. No branch, issue or pull request is created. All six CI gates and promotion of exactly the tested single image apply to publication; publication does not authorize production rollout.
