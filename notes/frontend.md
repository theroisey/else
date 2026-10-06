# Frontend system and private interaction rules

React/TypeScript, Vite, Tailwind semantic CSS variables, Font Awesome free-solid, TanStack Query, React Hook Form, and configured JIT-free Zod provide one interface. Source ownership: `app` routes/query defaults, `features/auth` identity/current grants, `features/shell` shell/navigation, explicit domain feature directories, `services/authenticated.ts` same-origin transport, and `components/ui` behavior/style primitives.

## Visual identity

Warm ivory/stone light surfaces and independently layered graphite dark surfaces use centralized text/border/status/chart tokens. Manrope operational typography pairs sparingly with Instrument Serif headings; self-hosted OFL notices ship. Ruled financial/operational sections, compact navigation, 1px separators and modest radii carry the identity. Avoid floating metric grids, gradients, fake dashboards and decorative luxury effects.

The authentic owner-supplied Roisey SVG path is preserved with 46:64 viewBox/aspect ratio and currentColor. Shell/login sizes are deliberate; favicon preserves the same mark on the owner's black-square reference. Website inspection was unavailable, so taupe is the interface accent choice rather than a claimed website brand color. Do not fabricate a brand quotation.

Light/Dark/System preferences persist and System follows prefers-color-scheme. An ordinary blocking same-origin bootstrap sets the theme before paint under strict CSP; React and cross-tab storage share validation. Restricted storage fails gracefully. Never reintroduce inline/eval or data-font allowances. Vite assetsInlineLimit stays zero; Font Awesome CSS is bundled with runtime CSS injection disabled. All schema consumers use `lib/validation` configured Zod rather than triggering its code-generation probe.

TextField/SelectField/Button share label/body/help/error geometry and CSS subgrids for the tallest localized label. Desktop controls are 40px, compact actions 32px, coarse/mobile targets 44px with 16px inputs. Preserve loading labels, visible focus, native selection, zoom, reduced motion, semantic named tables and local keyboard scrolling. Drawers/dialogs trap focus, close on Escape and restore it; destructive confirmation starts at Cancel.

## Data and drafts

Domain parsers strictly bound exact DTO fields, client/parent identity, period/currency/generation context, exact numeric strings, dates, unique ordered pages/cursors and safe labels. Never infer a grant from role names or a write capability. Optional client context is independently authorized, so task/planning/reminder/finance-only deep links do not probe unrelated records. Commands/search use actual registered pages and the existing authorized client-name endpoint; no invented global task/finance search.

Query keys partition actor/grants/client/parent/selection. Current guards run before display and late responses check mounted/current context. Loading or failed read-only history hides previous private data; grant changes remove unauthorized candidate titles. Same-actor authorized form placeholders can preserve a draft across a grant refresh without retaining unrelated resource titles. Do not key the entire app by grants: that destroys planning/reminder historical-reference drafts. Financial recovery controllers reset separately on identity/grant/auth changes.

Forms retain memory-only original revision and metadata/reference selections outside candidate pages. Background refresh does not replace a mounted draft. Stale writes block until explicit reload/discard; unknown writes do not retry automatically. Preserve exact payment/copy command UUID, original normalized payload and revision above routes for identical reconciliation after Back. Reload/unload/auth loss discards private in-memory recovery; manual history review must precede replacement. A conflict or absent checked history row does not prove noncommit.

Credential inputs are uncontrolled, clear before request and on unmount, and never enter React/query state, browser storage, URLs, screenshots or logs. Clearing does not guarantee physical JavaScript memory erasure. Payment references are masked until explicit reveal and absent from hidden labels; reveal resets with page/access changes. Costs require current manager access and never appear in copied billing terms.

## Time, numbers and language

Financial values stay exact strings/BigInt through input/display. Number is limited to bounded chart coordinates; exact labels/tables retain original values. Provider missing dates stay missing. Keep strong numeric alignment, tabular digits, large currency wrapping and contained chart panning in both themes.

Task/planning dates use stated device IANA zone; unchanged values preserve exact original microseconds and later fold occurrences. Changed spring gaps fail; changed overlaps use the documented first occurrence. Reminders retain explicit wall/zone/offset and require Earlier/Later choices for new ambiguous schedules. Use plain time text rather than native datetime-local that discards precision. Calendar dates remain calendar dates; application instants use reviewed locale/timezone display.

English is canonical, with complete Turkish, Romanian, German and French namespaces. Translate UI/static errors/definitions, never arbitrary customer text, machine IDs, currencies or IANA zone names. Locale formatting preserves exact money and interpolation. Persist nonsecret appearance/language; own-account language changes use current auth/CSRF and late-response ordering. Keep long translated labels/domain/client/email stress behavior and no document overflow.

## Verification

`make check` runs typed/linted source and meaningful unit/domain tests. `make test-browser` creates its own random loopback origin/private SQLite fixture and serves built assets through actual Pingora. Image mode uses the exact image with only a private synthetic data mount and nonroot invoking UID; the independent runtime gate verifies default production UID 65532. The fixture helper is host-only and refuses unmarked/nonprivate directories. Never direct it at existing data or replace production responses with fake providers.

Actual-image browser workflows cover login/cookie/expiry/revocation/admin/client/tasks/plans/reminders/activity/audit/finance/pricing/overview/providers/websites/language and light/dark responsive controls. Await the destination heading before editing fields shared with the outgoing route, such as provider setup/report dates; locator visibility alone can target the outgoing form during concurrent navigation. CSP attack probes test actual page headers; ordinary eval probe is a single test-only same-origin script fulfilled by Playwright, not a production artifact/endpoint. Traces/video/credential screenshots are disabled. Keep clearly synthetic screenshots temporary CI evidence rather than a stale committed image gallery.
