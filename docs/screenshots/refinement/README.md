# Refinement review evidence

All records here are synthetic and isolated. Operational captures display that provenance; login captures contain no account data. Reports use stored synthetic snapshots with no provider credentials or network synchronization. The local API build label identifies the review's baseline (`edb85c45de0a0abc20c78cd0bcbb83e67bfade21`), while the frontend/backend feature sources are the refinement worktree. These captures do not describe a production release or deployment.

| Manifest | Coverage |
| --- | --- |
| [Routes](routes.json) | 56 routes × five locales × two themes × eight widths = 4,480 checks |
| [Login](login.json) | Five locales × two themes × eight widths = 80 checks; versioned SVG favicon GET/HEAD |
| [Overlays](overlays.json) | Ten overlays × five locales × two themes × three widths = 300 checks; Tab containment, Escape, reduced motion |
| [Long-content follow-up](stress.json) | Ten routes × five locales × two themes × eight widths = 800 checks; legacy review, long names/domains/emails/tasks and exact EUR amounts beyond JavaScript's safe integer range |
| [Final priority follow-up](priority.json) | Four affected routes × five locales × two themes × eight widths = 320 checks after final grid, currency wrapping and switcher refinements |
| [Charts](charts.json) | Three stored provider reports × five locales × two themes × two widths = 60 checks; mobile keyboard panning |

Route/priority/stress widths are 1920, 1600, 1440, 1280, 1024, 768, 390 and 320px. Overlay widths are 1440, 390 and 320px; chart widths are 1440 and 390px. Tables, tabs and chart figures may scroll independently. The checks reject document and form-control overflow, wrong themes/locales and browser runtime errors. The complete matrix precedes the last narrowly scoped legacy-read/large-value refinements; the follow-ups exercise those final changes.

Manual inspection covered all page families in both themes, followed by translated priority pages, overlays, mobile screens, charts and long-content captures. Seventeen initial representative screenshots are retained alongside selected chart/stress follow-ups rather than committing every capture.

Representative views:

- [English light dossier](dossier-en-light-1440.png) and [dark dossier](dossier-en-dark-1440.png)
- [Turkish website portfolio](websites-tr-light-1440.png), [German website workspace](website-de-dark-1440.png), [French mobile website](website-fr-dark-390.png)
- [French finance](finance-fr-dark-1440.png), [German audit](audit-de-light-1440.png), [Romanian appearance](appearance-ro-light-1440.png)
- [German planning](plan-create-de-dark-1440.png), [task ledger](tasks-de-dark-1440.png), [reminder schedule](reminder-detail-de-dark-1440.png)
- [French mobile login](login-fr-dark-390.png), [website drawer](website-create-fr-dark-390.png), [audit drawer](audit-drawer-fr-dark-390.png)

The full frontend suite, real cookie/CSRF browser workflows, PostgreSQL migration/authorization tests, one-container lifecycle and security probe provide behavioral verification separately from these images. All six CI gates and promotion of the tested single image remain the publication requirement; evidence is recorded in issues #129–#131.
