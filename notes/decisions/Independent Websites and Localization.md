---
type: decision
status: active
created: 2026-10-05
tags: [websites, internationalization, authorization, database, frontend]
---

# Independent Websites and Localization

The owner's new pasted refinement request explicitly asks for issue planning and, after automatic review initially enforced the earlier prohibition, the owner expressly authorized new issues. #129 covers websites, #130 localization, #131 exhaustive interface review/favicon. Main and one application image remain mandatory. No production rollout is authorized.

## Website boundaries

Website read/write/archive inherit clients.view/update/archive, with clients.view also required for management. Integration associations require integrations.manage. No new website ACL hierarchy. Existing provider ownership, ciphertext AAD and synchronization jobs remain unchanged. An explicit association selects a website; unassigned historical connections stay client-level. Existing report cohorts/financial values are never combined implicitly. Client finance, pricing, general tasks/reminders remain client-level.

Legacy client website values stay intact. Migration creates one legacy property per nonempty value; uncertain formats are retained and flagged for review. New single-URL client creation creates a corresponding property for compatibility. Subsequent legacy profile-field edits do not silently overwrite an independently managed website. Website CRUD uses revisions and the existing authorization lock; primary selection demotes and audits the old primary in the same transaction. Archive retains history. Populated or edited website rollback is refused; untouched migration-only records can be removed since original values remain on clients.

## Localization boundaries

English is canonical. i18next/react-i18next provide namespace-based resources, English fallback and component updates. Translate interface copy, stable error-code explanations and reviewed provider metric descriptions; arbitrary client/task/notes content and machine identifiers stay untouched. Locale formatting must retain exact minor-unit/decimal values and stored currency. Nonsecret browser selection is allowed; secure self-service account preference uses existing cookie/CSRF patterns if introduced.

## Branding

The supplied favicon reference is a black square with the white authentic Roisey R, matching the owner's earlier SVG mark. Preserve that path and proportions, use the black background shown in the supplied favicon, and version its filename. Do not substitute the previous E favicon.

- [[Editorial Workspace and Appearance]]
- [[Client Records and Scope History]]
- [[Selected Provider Catalog and Binding]]

## Verification and operational boundaries

All 27 migrations pass an empty up/down/up round trip. Full PostgreSQL integration, Go unit/vet/race and targeted website timestamp serialization regressions passed. Website tests cover legacy byte preservation, primary races, stale revisions, client ownership, explicit associations, CSRF, provider dispatch, archived stored-report reads and rejected mutations. Account preference access is own-account only and audited. SQL JSON timestamps use UTC Z with six fractional digits to satisfy existing strict frontend contracts.

All five locales contain 19 namespaces and 1,841 canonical messages each; parity tests check placeholders. Exact decimal strings and BigInt values pass locale-aware Intl formatting without changing currency or financial calculations. Reminder display preserves microseconds and recorded timezone; UTC calendar dates remain calendar dates. Pending language writes are shared across mounted controls, and late account responses cannot override a newer choice. Legacy client website reads accept bounded safe text without requiring a valid URL; writes remain strict. This prevents an uncertain preserved legacy value from blocking independent property management.

Verification includes 556 frontend tests in 48 files, lint/typecheck/build, 25 real API browser workflows and the unchanged CSP security probe. The visual matrix covers 56 routes and 4,480 checks, five locales, both themes and eight viewport widths. Additional evidence covers 80 login, 300 overlay, 800 long-content, 320 final priority and 60 keyboard-chart checks. Final visual fixes constrain intrinsic grid widths, allow legacy-review actions to wrap, bound long-domain selectors and keep currency codes intact when unusually large values wrap. Synthetic screenshots and manifests are retained under docs/screenshots/refinement.

Local one-container verification passed initialization, migrations/runtime grants, process isolation, persistence/replacement, backup/restore, child failure and key safeguards. The exact final commit must also pass all six main CI gates; publication promotes the tested application image. Local vulnerability database access was unavailable, so the CI dependency gate is required rather than claiming a completed local Go vulnerability scan. Publication evidence belongs in #129–#131. No production rollout is authorized.

Preview infrastructure is disposable and isolated. Never reuse its synthetic fixtures, cookies, credentials, old build IDs or localhost ports as production configuration. Preserve unrelated developer servers when cleaning up task-owned previews.
