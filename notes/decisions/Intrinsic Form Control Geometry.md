---
type: decision
status: verified-local-awaiting-main-ci
created: 2026-10-05
tags: [frontend, accessibility, design]
---

# Intrinsic Form Control Geometry

Issue #134 applies the current official Vercel guidelines without replacing Roisey identity. Shared CSS control-height/compact-height and label-gap tokens normalize inputs, native selects and buttons. TextField and SelectField associate labels/description/errors; help follows the control. Native select/option background and foreground follow semantic light/dark tokens.

Field/filter CSS subgrids share the tallest localized label row before sizing controls. Balanced Clients search/tag/status/sort/action proportions collapse to two or one columns; action cells participate in the same row geometry. No items-end compensation, per-page pixel offsets or JS layout measurements. Grouped operational forms share the primitive, while compact navigation selectors retain their distinct semantic role. Mobile/coarse pointers use 44px targets and 16px inputs; respect zoom, visible keyboard focus and reduced motion. Loading actions keep original visible labels.

See [[Editorial Workspace and Appearance]], [[Independent Websites and Localization]], [interface audit](../../docs/control-geometry.md).

Local verification: complete frontend tests/lint/typecheck/build, actual-API browser workflows, full Go race/vet/command builds, full PostgreSQL integration (including unchanged capacity gate and 28-migration rollback/reapply) and final single-container persistence/offline restore checks pass. Current-worktree candidates remain distinct from exact-commit CI publication. The mandatory Go vulnerability scan awaits CI because the managed workspace blocks the official feed. See [verification report](../../docs/refinement-verification.md); final CI/registry evidence is recorded on the issue before closure.
