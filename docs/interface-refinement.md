# International website workspaces and interface review

Issues #129–#131 extend the existing editorial design with independent client websites, five interface languages, and the owner's black-square Roisey R favicon. The existing warm ivory/graphite themes, typography, financial calculations, authentication, permission model and single-image deployment remain in place.

See [website boundaries and migration](client-websites.md), [localization architecture](localization.md), and the [original visual design](frontend-redesign.md).

## Review scope

The rendered review covers every implemented route family, including login, workspace, client portfolio/profile/edit, tasks, plans and milestones, reminders, collections/payments, pricing/version history, provider connections and stored GA4/WooCommerce/Meta reports, activity, audit, users, roles, releases, appearance, public status, interface primitives and route errors. The new website portfolio, identity/workspace, switcher, integrations, analytics, commerce, marketing and activity receive the same treatment.

All five locales are exercised in Light and Dark at 1920, 1600, 1440, 1280, 1024, 768, 390 and 320px. The scripts check document and control overflow, locale/theme identity, browser errors, layout skeleton completion and font readiness. Independently scrolling tables, tabs and charts retain readable content rather than forcing the entire document to scroll horizontally.

Manual screenshot inspection covers every page family in both themes, with additional translated priority screens and mobile views. Dialog review covers website creation/editing, primary/archive confirmations, roles, assignments, audit inspection, payment cancellation, keyboard search and the account menu. Keyboard Tab remains inside modal dialogs; Escape closes overlays. Reduced-motion preferences suppress overlay and skeleton animation. Status text accompanies subdued semantic color; inputs retain visible theme-aware borders and focus states.

## Refinements resulting from review

- Login appearance/language controls form a compact two-row layout on narrow screens; long native language names no longer cause overflow.
- Website identity remains visible above its subordinate tabs. Empty provider sections explain explicit association and retain client-level financial/operational boundaries.
- Complete translated messages replace fragments in planning actions, date guidance, audit context, portfolio empty states and finance calendar labels. Sort labels use the operational meaning of “Order,” independently of commerce orders.
- Task due states and assignment fallbacks are localized. Reminder schedules use native date/clock formatting in the recorded timezone while preserving up to six fractional-second digits and the exact ISO instant in semantic time markup.
- Financial summaries constrain intrinsic grid widths and wrap large exact figures without splitting the currency code. Long-domain selectors and legacy-review actions stay inside narrow workspaces.
- Both account and settings language selectors share a pending write state. A slow locale load or account lookup cannot overwrite a newer user choice; competing controls cannot enqueue conflicting writes.
- The single versioned SVG favicon uses the supplied white Roisey path on the supplied black square, with preserved geometry. Theme-color metadata follows the resolved appearance before first rendering and after preference changes.

## Evidence and limitations

[Review evidence](screenshots/refinement/README.md) identifies the source worktree and verification counts. All operational screenshots contain isolated synthetic records and visibly mark that provenance. Provider reports use stored synthetic snapshots; no live provider request, production customer access or production deployment is part of this review.

The work uses `main` only. Migrations 26 and 27 are necessary domain/preference additions, described in their respective documents. Local checks are followed by all six CI gates and promotion of exactly the tested application image. Publishing that image does not authorize a production rollout.
