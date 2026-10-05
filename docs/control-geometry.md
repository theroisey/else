# Shared form and filter geometry

[#134](https://github.com/theroisey/else/issues/134) addresses inconsistent input/select/button sizing and baseline alignment. The previous layouts mixed individual padding rules, independently sized labels, helper text above inputs, and bottom-aligned action cells. Longer translations changed the label rows and made these compensations unreliable.

The current [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines) were read in full on 2026-10-05. Their interaction and accessibility guidance informs this change; Roisey's warm-neutral materials, typography and identity remain its design system.

## Layout contract

- `--control-height`, `--control-compact-height` and `--field-label-gap` centralize geometry. Normal desktop controls are 40px; compact operational actions are 32px. Narrow screens and coarse pointers use 44px targets and 16px input text.
- `TextField` and native `SelectField` share explicit labels, body structure, theme-aware borders/focus, descriptions and errors. Descriptions follow the control. Native select options set both background and foreground for Windows/dark mode.
- `field-grid` and `filter-grid` use CSS subgrid to share the tallest label row. Action cells participate in the same structure. No page-specific positional offsets or JavaScript layout measurements are used by the application.
- Clients allocate space deliberately to search, tag, status, sort and action; smaller layouts use two columns or one. Tasks, planning, reminders, finance and audit use the same geometry. Grouped create/edit forms, owner/assignee selectors, resource pickers, pricing, reporting periods and integration forms reuse it.
- Loading buttons preserve their visible action text and dimensions, expose busy/disabled state and provide the loading label for assistive technology. A spinner replaces an existing fixed-size icon; text-only actions do not gain a new icon while loading. Native keyboard interaction, browser zoom, reduced motion and semantic theme tokens remain intact.

## Verification

`frontend/e2e/controls.spec.ts` checks actual rendered Clients controls in English, Turkish, Romanian, German and French; light/dark; 375, 768, 1280, 1440, 1920 and 2880px widths. It measures the shared control height, desktop top alignment, associated labels, overflow, Tab navigation and Enter applying the real API filter. It uses only isolated synthetic fixture accounts.

The broader manual browser review uses the built frontend served by the actual Go API with disposable PostgreSQL, synthetic clients and finance records. Review includes create/edit forms, pickers, empty states, tables, account appearance, Release Center and administration at 320, 375, 768, 1024, 1280, 1440, 1920 and 2880px in both themes and all five locales. Theme/locale correctness and document/control overflow are measured; screenshots are inspected for alignment, rhythm and contrast. State tests retain loading/error/disabled behavior, permission revocation and financial correctness.

The 35-route matrix passed all 2,800 checks. The separate Clients regression passed all 60 combinations. Available/partial Release Center layouts were additionally reviewed in every locale/theme at 375/1440px using an explicitly synthetic release-response fixture; repository evidence tests use injected transports and never make real GitHub calls.

Review captures use disposable, clearly marked synthetic accounts:

- [German Clients, dark desktop](screenshots/control-geometry-clients-dark.png)
- [French Clients, light mobile](screenshots/control-geometry-clients-mobile.png)
- [German client form, light desktop](screenshots/control-geometry-client-form.png)
- [German Release Center, synthetic available evidence](screenshots/release-evidence-dark.png)

New Release Center messages exist in all five locale dictionaries. Technical SHA/digest/image identifiers remain untranslated. No new business operation, font, animation library or design dependency is introduced.
