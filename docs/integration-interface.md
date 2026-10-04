# Client integration workspace

Issue [#80](https://github.com/theroisey/else/issues/80), part of #24, consumes the owner-merged metadata reads and local-disconnect API. This frontend slice changes no production schema, provider adapter or credential writer.

## Routes and access

`/app/clients/:id/integrations` lists up to 25 stored connections in ascending UUID order. Next/Previous retain cursor history in memory; Refresh returns to the first page. Overview and Profile link here only with integrations.view on the current client (their own root already requires clients.view). Deep links survive sign-in only for canonical UUID list/detail routes.

`/app/clients/:id/integrations/:connectionID` displays provider, recorded state, connection reference and exact UTC metadata timestamps. Both routes require independent clients.view and integrations.view on the exact client. Management additionally requires integrations.manage, a freshly read active client and an eligible stored connection state. View-only and archived-client history stay readable with no disable control. Local-disabled/disconnected and revision-exhausted records offer no repeat disable action.

The interface shows stored facts, not current provider health. Empty states do not invent connections or performance data. There is no connect, credential entry, OAuth, sync or remote-revocation control while their producer contracts remain incomplete. Only explicitly isolated browser SQL supplies synthetic test records; application and production databases gain no connection seed.

## Confirmation and recovery

Disable local use opens the shared accessible confirmation dialog. Keep local use receives initial focus; Escape/backdrop dismissal works before submitting. Pending confirmation prevents duplicate submission and dismissal. POST uses the cookie/Origin/JSON/CSRF transport and exactly `{revision: "<current decimal revision>", confirmed: true}`.

A valid result must remain revocation_failed with unavailable remote revocation and manual_action_required=true. The page keeps an attention panel telling the user to remove the application's access in the recorded provider's account settings; it never claims verified revocation. HTTP 200 confirms only the local fence. Credentials and audit history remain retained according to the backend policy. [Selected-provider compatibility](provider-workspace-compatibility.md) adds strict GA4/WooCommerce labels as a prerequisite for separately reviewed backend activation.

No mutation is automatically retried. A conflict, network/lost response or invalid response disables confirmation until Reload connection or Close and reload successfully re-reads both current metadata and client status. A new attempt requires a new confirmation using the new revision. A committed-but-lost response reconciles to the local-disabled state and removes the action. Closing the error dialog without reloading keeps the error/action lock. Actor/grant/client/connection changes discard the previous record and dialog; old asynchronous results cannot populate the new context. Returning to a route also reads current state before displaying records or actions.

## Validation and evidence

The integration domain validates strict envelopes and exactly seven metadata fields, same-client/route identity, fixed provider and state enums, canonical nonzero UUIDs, positive int64 revisions as strings and bounded real UTC timestamps with PostgreSQL microseconds. Pages must increase monotonically and canonical versioned cursors must bind the client and final row. Unknown account/generation/credential fields, dishonest revocation results and revision/identity mismatches fail with a fixed safe message.

Queries are partitioned by domain, actor, effective grants and client; detail keys add connection. Fetching/error states hide cached records and actions. Authorization errors trigger session refresh through the existing operation helper. No private request body or error detail is displayed or persisted in browser storage/telemetry. The existing backend owns atomic integration_connection.updated auditing; frontend reads create no domain audits.

Contract/interaction coverage exercises malformed and expanded responses, large revisions, timestamps, cross-client cursors, independent grants, paging, pending guards, error recovery, archive/view-only/terminal states, actor replacement, route changes and late reads. The real cookie-session browser flow covers pagination, keyboard confirmation, stale conflict, commit-then-response-loss, successful local disable, freshly authorized no-op and audit counts, manage/view revocation and archive history. Desktop/mobile screenshots contain only labeled synthetic fixtures; CI retains them as browser artifacts with traces/video disabled.

Local lint/typecheck/build and all 439 unit/interaction tests (34 files, including 48 focused integration cases) pass. Real Chromium with disposable PostgreSQL 17 passed all 14 cookie-session browser flows. Required final-head CI evidence for PostgreSQL 18, containers and the complete gate set is recorded in PR/Issue metadata before review; no Docker availability or provider lifecycle coverage is inferred from the local run.

The broader lifecycle remains unfinished in #24: approved provider policy/fixtures, OAuth/SSRF, actual remote revocation and synchronization, recovery safety and bulk rotation/key retirement. #82 adds separate backend [protected startup and declared restore checks](integration-key-startup.md), with documented detection limits. This interface grants none of those capabilities.

## Synthetic visual review

The retained views come from the real cookie-session flow on a disposable database. Every image labels its isolated synthetic data. Wide tables scroll within a named keyboard-focusable region; page layout remains contained on narrow screens.

- [Desktop connection list](screenshots/integrations-desktop.png)
- [Mobile connection list](screenshots/integrations-mobile.png)
- [Mobile confirmation](screenshots/integration-confirm-mobile.png)
- [Desktop manual-revocation attention](screenshots/integration-manual-desktop.png)
- [Mobile manual-revocation attention](screenshots/integration-manual-mobile.png)
