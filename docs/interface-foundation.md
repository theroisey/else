# Interface foundation

Related Issue: [#11](https://github.com/theroisey/else/issues/11).

## Scope

Issue #11 establishes the shared visual tokens and only the primitives already required by login, the permission-aware shell, forms and dense records: `Button`, `TextField`, `Status`, `Table` and `Dialog`. The components live in `frontend/src/components/ui`; the working `/interface` route is a development review surface, not a product module or an exhaustive component catalog.

The existing service-status route remains real and now consumes the shared Button and Status primitives. The review route uses only in-memory interaction state and an accurate component-inventory table. It contains no customer-like fixtures, credentials, fake operational metrics or backend writes.

## Tokens and visual rules

Tailwind consumes the tokens in `src/app/styles.css`. The base palette uses warm grayscale canvas, surface, ink and border values. Shared spacing uses a four-pixel base; typography uses a local system stack; radii remain three to five pixels; elevation is reserved for modal separation. Components use token names rather than private hex values or independent spacing scales.

Success, warning and danger are restrained semantic exceptions to the monochrome base. They always accompany explicit text. Measured foreground/background contrast is:

| Pair | Ratio |
| --- | ---: |
| Primary ink / canvas | 16.28:1 |
| Muted text / canvas | 5.83:1 |
| Muted text / surface | 6.42:1 |
| Success text / surface | 7.67:1 |
| Warning text / surface | 7.52:1 |
| Danger text / surface | 8.84:1 |
| Danger button text / fill | 7.31:1 |

The three-pixel focus indicator is 16.28:1 against the canvas and remains visible independently of color state. Compact controls remain at least 32 pixels high and default inputs/actions 40 pixels high. Narrow layouts keep the page within the viewport; wide tables scroll inside their own bordered region. Reduced-motion preferences collapse nonessential animation and transitions.

## Primitive contracts

- `Button` defaults to `type="button"`, supports primary, secondary, danger and ghost treatments, preserves a visible text label, and exposes disabled/loading state with `aria-busy`. Font Awesome free-solid icons supplement labels; they never replace them.
- `TextField` binds its visible label, optional guidance and validation error using stable IDs and `aria-describedby`. Invalid state uses `aria-invalid` and a live alert while retaining a visible border and message.
- `Status` provides neutral, success, warning and danger treatments. Consumers supply a visible text label so color is not the only state signal.
- `Table` supplies a semantic caption and a named, keyboard-focusable scrolling region while consumers retain native headings, rows and cells. It does not invent sorting or pagination before a real collection needs them.
- `Dialog` uses the native dialog surface with an accessible name and description, modal backdrop, initial focus, Tab/Shift+Tab containment, Escape/cancel and backdrop dismissal, body-scroll locking, and focus restoration. Destructive actions remain explicit buttons supplied by the consumer.

No remote font, Font Awesome kit or additional UI dependency is loaded. Only the existing free-solid Font Awesome package is used.

## Verification

Component tests cover label/help/error relationships, local form success, disabled actions, semantic inventory, modal naming, initial focus, focus containment, Escape dismissal, explicit confirmation and focus restoration. Existing health/readiness tests continue to cover loading, success, unavailable, error and retry behavior after adopting the primitives.

The required frontend gates are lint, strict TypeScript, Vitest, production build and dependency audit. Chromium checks load the real Vite route at 1440×1000, 820×1050 and 390×844; all three have exact viewport-width containment and no console errors. The same browser run verifies input validation plus dialog focus and Escape behavior.

- [Desktop review](screenshots/interface-review-desktop.png)
- [Tablet review](screenshots/interface-review-tablet.png)
- [Mobile review](screenshots/interface-review-mobile.png)

Issue #12 may compose these primitives into the authenticated application shell. It must keep backend permissions authoritative and should extend the primitive set only when a concrete state requires it.
