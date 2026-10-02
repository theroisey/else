# Client interface and workspace

Related Issue: [#14](https://github.com/theroisey/else/issues/14). The frontend consumes the owner-merged [client API](clients.md) without schema, permission or audit-policy changes.

## Routes and access

Clients navigation appears for some effective `clients.view` grant or global `clients.create`. The list returns only records authorized by the server. A create-only user sees creation context without fetching a collection or detail; confirmed creation does not assign access. Detail requires view for the exact client; edit requires both view and update for that client; archive requires view and archive. Role names and knowledge of an ID never grant access. Invalid/wrong-scope deep links are guarded before the domain fetch. Missing/inaccessible real records share the API's safe unavailable message.

- `/app/clients`: searchable authorized table, or create-only context.
- `/app/clients/new`: complete profile/contact/tag form.
- `/app/clients/:id`: [operational overview](overview-interface.md) with compact context and authorized attention/finance/activity.
- `/app/clients/:id/profile`: full profile, contacts, timestamps, edit/archive controls and a link back to Overview.
- `/app/clients/:id/edit`: active profile replacement form.

Overview is implemented. Issue #16 adds a [Tasks module](task-interface.md) link only for effective exact-client `tasks.view`; task-only users can open validated task deep links without client-profile access. The compact Additional modules disclosure identifies remaining unavailable modules as plain text, with no fake metrics, placeholder links or actions. Archived profiles remain readable to authorized users with no edit, archive or restore controls. Client navigation remains selected on detail/edit/task routes when available; breadcrumbs and cancel links lead back to actual destinations.

## Lists and forms

List filters match the API: literal name search, exact lowercase tag, active/archived/all status, and client UUID ascending/descending order. Apply filters resets previous/next cursor history. Pages use the server cursor, fixed limit 25 and no invented total. Filters stay in component memory, without query URLs or browser persistence. Background errors withhold old table/detail content and offer safe retry.

React Hook Form manages the complete client draft and ordered contact array; Zod applies the API's Unicode bounds, trimming, ASCII email policy, HTTP(S) website rule, control-character rejection and distinct normalized tags. Tags use one label per line; notes remain one paragraph because the backend rejects line breaks. Contact removal and tag changes replace the complete child set on PUT. No client-provided actor, ID or revision is added to creation.

The loaded revision is retained with an edit draft. A stale/archived conflict preserves the draft and offers an explicit reload that discards it, refreshes the full record and revision, and requires another save. Archive captures the reviewed record/revision when opening its confirmation. Cancel receives initial focus; failure shows a safe message and requires cancellation/refresh before another review. Success is displayed only after the target ID and incremented revision are confirmed by the API.

Administration and clients share the same same-origin authenticated transport: browser-managed cookies, no-store, redirect rejection, bounded timeout, JSON checks and request-time CSRF. Domain services validate their own endpoints and responses. Client query keys include identity and current grants; shrinking permissions causes a new authorized fetch. Session expiry/logout/identity changes clear private queries. Completed client reads verify the identity is still current before returning or setting cache data. Form values stay in JSON write bodies, with no browser persistence, mutation cache, logging or frontend audit payloads. Name/tag filters use the documented GET query contract; navigation/return URLs contain no filter values and backend route logs omit query values.

Client routes load separately with loading and safe page-load error states. The form/schema dependencies are excluded from the initial login/public-page bundle. No general table dependency is added: the existing semantic Table already supports the server-paginated records and keyboard scrolling.

## Verification and screenshots

Local lint, strict typecheck, 69 Vitest tests, production build and production dependency audit pass (zero vulnerabilities). Tests cover client-only/create-only permissions, wrong-client guards, cache partitioning after grant changes, session expiry, bounded filters/cursors, loading/errors/empty/retry states, normalized contact/tag validation, stale-draft reload, confirmed archive and archived history.

All five Playwright flows pass against a fresh disposable PostgreSQL 17.11 database and the real Go API. The new flow covers 25-record pagination, real create/edit writes, a concurrent editor conflict, scoped read-only access and denied deep links, filtered archived lookup, retained contacts, and actual audit event order. Desktop/tablet/mobile checks verify contained layouts; existing shared primitives provide keyboard navigation and dialog focus. CI remains required for pinned Chromium, PostgreSQL 18 and container evidence. Local Docker pulls remain rate-limited. No merge or deployment is performed by the agent.

These screenshots contain clearly labelled synthetic data from the disposable API test, with no cookies, request bodies, traces or videos:

- [Client table desktop](screenshots/clients-desktop.png), [mobile](screenshots/clients-mobile.png).
- [Client form mobile](screenshots/client-form-mobile.png).
- [Workspace desktop](screenshots/client-workspace-desktop.png), [mobile](screenshots/client-workspace-mobile.png).
- [Archive confirmation mobile](screenshots/client-archive-mobile.png).
