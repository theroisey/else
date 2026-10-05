---
type: decision
status: active
created: 2026-10-04
tags:
  - frontend
  - design-system
  - appearance
  - accessibility
---

# Editorial Workspace and Appearance

The owner requests a complete premium interface redesign under the existing frontend foundation and shell (#11/#12), using main only and creating no issues. The implementation replaces repeated generic containment with ruled sections, client dossier tabs, financial ledgers, restrained statuses and an editorial hierarchy. Manrope and Instrument Serif are self-hosted OFL fonts; their licenses ship in the single application image. Domain/API/schema/financial/auth contracts remain unchanged.

Light/Dark/System use centralized semantic CSS variables. A blocking classic same-origin bootstrap applies the saved or system theme before rendering without weakening CSP. React controls share the validated preference, follow device changes only in System, and handle cross-tab and restricted-storage behavior. Vite's inline asset optimization must remain disabled so small font subsets do not become CSP-blocked data fonts; public bootstrap must remain in the Docker build context. Normalize built static directories/files to 0755/0644: copied public files retain source modes, and a 0600 bootstrap stops the unprivileged API from loading the frontend.

Command search uses actual registered destinations, current client modules and the existing authorized client-name API. It deliberately does not invent a global task/finance endpoint. Client navigation derives from effective grants; client audit requires both global audit and client view. Editing/inspection drawers reuse native dialog behavior; destructive confirmations and recovery flows retain their semantics.

The owner supplied the official Roisey SVG on 2026-10-05, resolving the asset blocker. Brand.tsx preserves the original path and 46:64 geometry, adds its matching viewBox and uses currentColor for light/dark contrast. The desktop/mobile/login heights are 32/28/40px. No filter or redraw is used. Website inspection is still blocked by the managed network's HTTP 403: provenance is the owner-supplied code, and taupe is our restrained interface accent rather than a claimed website brand color. No brand quote is fabricated.

The integrated mark passed 28 shell/login checks across seven viewport widths and both themes. The 250-check priority matrix, drawer/chart reviews and all 32 saved screenshots were refreshed with the mark. All 22 real-API browser tests and 15 focused authentication/appearance/search unit regressions passed after integration.

Local review covered 49 routes and 698 light/dark/responsive checks, followed by 250 priority-screen checks and additional native drawers, account controls and charts. All screenshots use isolated synthetic PostgreSQL fixtures and are linked from the redesign guide. The full 522-test frontend suite, final 44 report regressions, fresh-database 22-test actual-API browser suite, strict built-artifact CSP checks, dependency audit and one-container installation/persistence/backup/restore safeguards passed. Sparse chart bars are capped and centered; mobile plots retain readable labels in keyboard-scrollable figures. Continue under the existing #11/#12 rather than creating an issue or branch. Exact-head CI and single-image publication remain required before declaring publication verified; none of the visual evidence establishes production rollout authority.

- [[Interface Foundation]]
- [[Application Shell and Session Recovery]]
- [[Frontend Browser Security]]
- [Redesign implementation and verification](../../docs/frontend-redesign.md)
