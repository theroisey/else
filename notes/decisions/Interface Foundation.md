---
type: decision
status: merged
created: 2026-10-01
tags:
  - frontend
  - accessibility
  - design-system
---

# Interface Foundation

Issue #11 uses a warm monochrome base with restrained semantic success, warning and danger tokens. Text always accompanies semantic color. Shared Tailwind tokens govern color, four-pixel spacing, system typography, compact radii, focus and modal elevation; components do not own private visual values.

The initial set is deliberately bounded to Button, TextField, Status, Table and Dialog because those primitives have concrete consumers in login, shell, forms and dense records. Font Awesome remains free-solid only and supplements visible labels. No remote font, second icon style or general component framework is added.

Keyboard focus is explicit. Dialogs name and describe themselves, contain Tab navigation, close on Escape/cancel or backdrop, and restore focus. Normal text exceeds WCAG AA contrast, narrow layouts contain tables locally, and reduced-motion preferences suppress nonessential motion.

The `/interface` route is a working development review surface with local state and actual component inventory. It is not a product module and contains no fake customer or operational data. Issue #12 owns the authenticated application shell.

- [[Frontend Foundation]]
- [Interface foundation guide](../../docs/interface-foundation.md)
- [Issue #11](https://github.com/theroisey/else/issues/11)
- [Merged PR #44](https://github.com/theroisey/else/pull/44)
- [Main verification and publication](https://github.com/theroisey/else/actions/runs/36899970874)
