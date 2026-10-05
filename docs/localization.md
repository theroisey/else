# Interface localization

Issue #130 adds English (`en`), Turkish (`tr`), Romanian (`ro`), German (`de`) and French (`fr`). Language controls use native names on login, in the account menu and under personal settings. They update the interface immediately, preserve nonsecret browser preference and save the signed-in user's own account preference.

## Architecture

`frontend/src/i18n` owns i18next/react-i18next, domain JSON catalogs, formatting and language controls. English source copy is the canonical flat message identifier; resource keys are separated into common, authentication, settings and operational domains. English loads eagerly; each selected non-English locale loads its domain chunks before activation. Missing messages fall back to readable English. A parity test requires all five catalogs to contain every canonical key and preserve interpolation placeholders.

Initialization chooses browser preference, then the first supported browser language, then English. After authentication, a saved account preference is applied unless a more recent local selection superseded the request. Aborted/late account reads cannot overwrite a new choice. Cross-tab browser changes are synchronized. Failed resource loads retain a usable language; failed account saves report the error while retaining the browser selection. Cookies remain the existing authentication mechanism; no credentials are stored locally.

Migration 27 adds `app.user_locale_preferences`. GET `/api/v1/auth/preferences` returns `{data:{locale:null|"en"|"tr"|"ro"|"de"|"fr"}}`; authenticated PUT accepts `{locale:"..."}` with the existing CSRF header. There is no user-ID parameter or arbitrary-user access. Writes create safe existence/revision audit events and use the established authorization lock. Rollback refuses populated preference/audit history.

## Content and exact formatting

Translate interface labels, notices, validation, accessibility text, empty/loading/error states and the four supported GA4 metric explanations. Do not translate client names, task descriptions, internal notes, emails, URLs, provider dimension values, permission keys, event types, UUIDs or stored machine codes. Enum values stay unchanged; owned presentation labels are localized separately.

Dates use the established report/calendar or record timezone. UTC calendar dates retain their day rather than shifting through the user's timezone. Reminder clocks preserve stored fractional seconds, including microseconds beyond Intl's three-digit limit. Exact monetary minor units and provider decimal strings retain all digits through Intl formatting; financial currency codes and exponent rules come from stored records. No conversion to a floating-point amount or currency guessing is introduced. The frontend's ISO/date and decimal input contracts remain stable; display formatting does not reinterpret input data. Decimal form inputs continue to use the canonical dot separator explained by their localized guidance.

Built-in Zod validation uses the selected language. Reviewed custom validators retain canonical English messages and are translated at the display boundary. Notices retain their source message so changing the language does not leave stale English feedback. Brand/provider names, keyboard keys and protocol identifiers are intentionally unchanged.

## Contributing

Use `copy(source, domain, values)` and `useLocale()` in display components. Add all five domain resources for every message, including errors and screen-reader labels. Interpolate complete messages rather than concatenating fragments whose word order varies by language. Pass customer content as interpolation values without translating it. Use the exact formatting helpers for amounts, counts, dates and percentages.

Run catalog parity, exact-format and preference-race tests alongside the affected domain tests, then review translated layouts in both themes. Account language persistence is covered by real cookie/CSRF browser requests.
